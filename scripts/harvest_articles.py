#!/usr/bin/env python3
"""
harvest_articles.py - read the article page, not just the feed.

Two things these feeds do not give the reader, both available on the article
page the feed links to.

A picture. Roughly half the articles arrive with no image: Bloomberg, the FT,
the Economist, BBC and VeloNews all strip media out of their RSS, while
CyclingNews, Autosport, the Guardian and the NYT include it. The picture
usually exists anyway, in the Open Graph metadata every publisher maintains so
their links look right when shared. This is how Google News illustrates
everything: it reads the article, not the feed.

The article itself. Measured across the 549 articles live at the time of
writing, the median item carries 176 characters of text - one sentence. Four
sources send the whole piece (CyclingNews, The Race, Pinstripe Alley, Posting
and Toasting, all 589-740 words); the BBC sends 16 words, the Economist 8 and
Autosport none at all. Without the body there is nothing to read on a plane.

So this walks the items that need either, fetches each article page once, and
records what it finds as `lbImage` and `lbText` on the item. The front end
prefers those fields and falls back to the feed's own summary, so a failure
here costs nothing beyond what was already missing.

What it cannot fix: Bloomberg, the FT and the Economist refuse this build
outright - 0 of 118 article pages answered across those three - and are
paywalled besides. They stay headline-only however long this runs.

Results are cached in config/article-cache.json, keyed by article URL and
committed with the build, so each article is fetched once rather than once an
hour. Misses are cached too - for a shorter window, so a publisher that starts
answering is picked up again rather than written off forever.

Run:  scripts/harvest_articles.py [--limit N] [--dry-run]
"""

from __future__ import annotations

import argparse
import html as html_mod
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
FEED_DIR = ROOT / "docs" / "feeds"
CACHE_PATH = ROOT / "config" / "article-cache.json"
# Carried over when this script only harvested pictures, so a rename does not
# throw away a warm cache and re-fetch every article at once.
LEGACY_CACHE_PATH = ROOT / "config" / "image-cache.json"

# A hit is stable - neither the lead image nor the body of a published article
# changes much. A miss is worth retrying, because it is usually a timeout, a
# rate limit or a consent wall rather than a genuine absence.
HIT_TTL = 90 * 24 * 3600
MISS_TTL = 7 * 24 * 3600

# Ceiling on new fetches per build, so a slow publisher cannot stall the hourly
# job. Anything not reached this run is simply retried next run.
DEFAULT_LIMIT = 400
WORKERS = 8
TIMEOUT = 10

# The body needs more than the <head> the image alone needed, but a news page
# is mostly markup and script; a megabyte of it is far past where the article
# ends.
MAX_BYTES = 900_000

# What gets written into the feed JSON, which is committed every hour - so this
# is a repository-size decision as much as a reading one. 6000 characters is
# about a thousand words, which is the whole piece for all but a longread.
MAX_TEXT = 6000

# Below this the extraction found a consent wall, a paywall stub or a nav
# skeleton rather than an article, and storing it would be worse than the
# feed's own summary.
MIN_TEXT = 400

# An item whose feed summary is already this long needs no body fetched: the
# four sources that send the whole piece land well above it.
FEED_TEXT_ENOUGH = 1200

# Identifying the crawler is the polite minimum, and some publishers serve a
# stripped page to anything that looks like a default urllib client.
USER_AGENT = (
    "Mozilla/5.0 (compatible; liveboat-article-harvester/1.0; "
    "+https://github.com/c16bi/news)"
)

# Enclosure mime types in these feeds are unreliable - mostly absent or
# "text/plain" even for JPEGs - so the extension is what decides. Kept in step
# with IMAGE_RE in templates/custom/include/assets/custom.js.
IMAGE_RE = re.compile(r"\.(jpe?g|png|webp|avif|gif)(\?|#|$)", re.I)

META_RE = re.compile(r"<meta\b[^>]*>", re.I)
ATTR_RE = re.compile(
    r"""(property|name|itemprop|content)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))""",
    re.I,
)
# In preference order: og:image is what publishers curate for sharing, the
# twitter variants are its usual stand-in, and itemprop is the schema.org form.
IMAGE_KEYS = (
    "og:image:secure_url",
    "og:image:url",
    "og:image",
    "twitter:image:src",
    "twitter:image",
    "image",
)

TAG_RE = re.compile(r"<[^>]*>")
# Everything that sits inside an article element but is not the article.
STRIP_RE = re.compile(
    r"<(script|style|noscript|svg|form|nav|header|footer|aside|figure|figcaption|"
    r"iframe|template|button|select)\b[^>]*>.*?</\1\s*>",
    re.I | re.S,
)
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
ARTICLE_RE = re.compile(r"<article\b[^>]*>(.*?)</article\s*>", re.I | re.S)
PARA_RE = re.compile(r"<p\b[^>]*>(.*?)</p\s*>", re.I | re.S)

# Boilerplate that survives paragraph extraction on most news sites.
JUNK_RE = re.compile(
    r"^(advertisement|sign (up|in)|subscribe|share this|read more|related|"
    r"follow us|cookie|accept all|photograph:|image:|getty images|"
    r"copyright \d{4}|all rights reserved)\b",
    re.I,
)


def text_of(markup: str) -> str:
    """Visible text of an HTML fragment, entities resolved."""
    return re.sub(r"\s+", " ", html_mod.unescape(TAG_RE.sub(" ", markup))).strip()


def feed_text_length(item: dict) -> int:
    return len(text_of(item.get("content") or ""))


def has_enclosure_image(item: dict) -> bool:
    url = (item.get("enclosureUrl") or "").strip()
    if not url:
        return False
    if (item.get("enclosureMime") or "").startswith("image/"):
        return True
    return bool(IMAGE_RE.search(url))


def parse_meta(html: str) -> dict[str, str]:
    """Pull the meta tags we care about out of a chunk of HTML.

    Deliberately regex rather than an HTML parser: the input is a truncated,
    frequently malformed page from an arbitrary publisher, we want six specific
    attributes out of it, and the standard library's parser is stricter about
    that than it needs to be here.
    """
    found: dict[str, str] = {}
    for tag in META_RE.findall(html):
        key = content = None
        for attr, _, dq, sq, bare in ATTR_RE.findall(tag):
            value = dq or sq or bare
            attr = attr.lower()
            if attr == "content":
                content = value
            else:
                key = value.strip().lower()
        if key and content and key in IMAGE_KEYS and key not in found:
            found[key] = content
    return found


def pick_image(html: str, page_url: str) -> str:
    metas = parse_meta(html)
    for key in IMAGE_KEYS:
        raw = (metas.get(key) or "").strip()
        if not raw or raw.startswith("data:"):
            continue
        absolute = urljoin(page_url, raw)
        # An http image on an https page is blocked as mixed content, so it is
        # no more use to us than no image at all.
        if urlsplit(absolute).scheme == "https":
            return absolute
    return ""


def pick_text(html: str) -> str:
    """The article body, as paragraphs.

    A readability-grade extractor would score every node; this does the two
    things that get most of the benefit on news pages. Prefer whatever sits
    inside <article> - nearly every publisher marks it, and it excludes the
    recirculation rails that otherwise dominate the page. Then take the <p>
    elements, because a news article is paragraphs and its furniture is not.

    Where there is no <article>, the whole document is used and the paragraph
    filter carries the weight on its own. Returns "" when what came back is
    too short to be an article, which is what a consent wall or a paywall stub
    looks like from here.
    """
    cleaned = STRIP_RE.sub(" ", COMMENT_RE.sub(" ", html))

    # Longest <article> rather than the first: some pages open with a stub
    # element for the recirculation rail.
    bodies = ARTICLE_RE.findall(cleaned)
    scope = max(bodies, key=len) if bodies else cleaned

    paragraphs = []
    for raw in PARA_RE.findall(scope):
        line = text_of(raw)
        # One-clause paragraphs on a news page are captions, bylines and
        # share prompts far more often than they are prose.
        if len(line) < 40 or JUNK_RE.match(line):
            continue
        paragraphs.append(line)

    body = "\n\n".join(paragraphs).strip()
    if len(body) < MIN_TEXT:
        return ""
    if len(body) <= MAX_TEXT:
        return body
    # Cut at a paragraph rather than mid-sentence where one is close enough.
    cut = body.rfind("\n\n", 0, MAX_TEXT)
    return (body[:cut] if cut > MAX_TEXT // 2 else body[:MAX_TEXT]).rstrip() + "…"


def fetch_article(url: str) -> tuple[str, str]:
    """(image, text) for one article; ("", "") for anything unreachable."""
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-GB,en;q=0.9",
        },
    )
    try:
        with urlopen(request, timeout=TIMEOUT) as response:
            if "html" not in (response.headers.get("Content-Type") or "").lower():
                return "", ""
            raw = response.read(MAX_BYTES)
            charset = response.headers.get_content_charset() or "utf-8"
        page = raw.decode(charset, "replace")
        return pick_image(page, url), pick_text(page)
    except Exception:
        # Any failure - timeout, 403, TLS, redirect loop, bad encoding - is the
        # same outcome to the reader: the article keeps whatever the feed gave
        # it. Cached as a miss and retried in a week.
        return "", ""


def load_cache() -> dict:
    for path in (CACHE_PATH, LEGACY_CACHE_PATH):
        try:
            with path.open(encoding="utf-8") as handle:
                cache = json.load(handle)
            if isinstance(cache, dict):
                return cache
        except (OSError, ValueError):
            continue
    return {}


def save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(cache, handle, indent=1, sort_keys=True)
        handle.write("\n")
    tmp.replace(CACHE_PATH)

    # The cache used to live under the old name. Retire it here, once the new
    # file is safely written, rather than renaming it in a commit: main rewrites
    # this file every hour, and a rename in a branch conflicts with that for as
    # long as the branch is open.
    try:
        if LEGACY_CACHE_PATH.exists():
            LEGACY_CACHE_PATH.unlink()
    except OSError:
        pass


def cache_entry(cache: dict, url: str, now: float) -> dict | None:
    """The live cache entry for `url`, or None if absent or expired."""
    entry = cache.get(url)
    if not isinstance(entry, dict):
        return None
    ttl = HIT_TTL if (entry.get("img") or entry.get("txt")) else MISS_TTL
    if now - entry.get("ts", 0) > ttl:
        return None
    return entry


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"maximum articles to fetch this run (default {DEFAULT_LIMIT})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be fetched without writing anything",
    )
    args = parser.parse_args()

    if not FEED_DIR.is_dir():
        print(f"harvest_articles: no {FEED_DIR}, nothing to do")
        return 0

    now = time.time()
    cache = load_cache()

    # Archives hold the same articles the live feeds already carried, so
    # harvesting the live files covers them once the cache is warm.
    feed_files = sorted(
        path
        for path in FEED_DIR.glob("*.json")
        if not path.name.endswith("_archive.json") and path.name != "icons.json"
    )

    feeds = []
    wanted: list[str] = []
    seen: set[str] = set()
    need_img = need_txt = 0

    for path in feed_files:
        try:
            with path.open(encoding="utf-8") as handle:
                feed = json.load(handle)
        except (OSError, ValueError) as error:
            print(f"harvest_articles: skipping {path.name}: {error}", file=sys.stderr)
            continue
        feeds.append((path, feed))

        for item in feed.get("items") or []:
            url = (item.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)

            wants_image = not has_enclosure_image(item)
            wants_text = feed_text_length(item) < FEED_TEXT_ENOUGH
            if not (wants_image or wants_text):
                continue
            need_img += wants_image
            need_txt += wants_text

            entry = cache_entry(cache, url, now)
            if entry is None:
                wanted.append(url)
            elif wants_text and "txt" not in entry:
                # An entry written before text was harvested. Re-fetch once so
                # the rename does not leave every old article body-less.
                wanted.append(url)

    to_fetch = wanted[: max(args.limit, 0)]
    print(
        f"harvest_articles: {len(seen)} articles, "
        f"{need_img} want a picture, {need_txt} want text; "
        f"{len(wanted)} not cached, fetching {len(to_fetch)}"
    )

    if args.dry_run:
        for url in to_fetch[:20]:
            print("  would fetch", url)
        return 0

    if to_fetch:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for url, (image, text) in zip(to_fetch, pool.map(fetch_article, to_fetch)):
                cache[url] = {"img": image, "txt": text, "ts": int(now)}

    # Forget articles that have aged out of every feed, so the cache tracks the
    # feeds rather than growing forever.
    for url in [url for url in cache if url not in seen]:
        del cache[url]

    images = texts = 0
    for path, feed in feeds:
        changed = False
        for item in feed.get("items") or []:
            url = (item.get("url") or "").strip()
            if not url:
                continue
            entry = cache_entry(cache, url, now)
            if not entry:
                continue

            image = entry.get("img") or ""
            if image and not has_enclosure_image(item):
                item["lbImage"] = image
                images += 1
                changed = True

            text = entry.get("txt") or ""
            # Only when it beats what the feed already sent - for the sources
            # that syndicate the whole piece, the feed's own copy is better
            # than anything scraped off the page.
            if text and len(text) > feed_text_length(item):
                item["lbText"] = text
                texts += 1
                changed = True

        if changed:
            # Match liveboat's own output exactly - compact, raw UTF-8 - so the
            # only thing in the diff is the fields we added.
            with path.open("w", encoding="utf-8") as handle:
                json.dump(feed, handle, ensure_ascii=False, separators=(",", ":"))

    save_cache(cache)

    with_img = sum(1 for e in cache.values() if e.get("img"))
    with_txt = sum(1 for e in cache.values() if e.get("txt"))
    print(
        f"harvest_articles: {images} items given a picture, {texts} given text; "
        f"cache holds {len(cache)} urls ({with_img} with a picture, "
        f"{with_txt} with text)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
