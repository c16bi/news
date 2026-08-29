#!/usr/bin/env python3
"""
harvest_images.py - give image-less articles a picture.

Roughly half the articles in these feeds arrive with no image: Bloomberg, the
FT, the Economist, BBC and VeloNews all strip media out of their RSS, while
CyclingNews, Autosport, the Guardian and the NYT include it. The picture
usually exists anyway - it is on the article page, in the Open Graph metadata
every publisher maintains so their links look right when shared. This is how
Google News illustrates everything: it reads the article, not the feed.

So after liveboat writes docs/feeds/*.json, this walks the items that have no
usable enclosure, fetches the article's <head>, and records whatever og:image
it finds as an `lbImage` field on the item. The front end prefers that field
and falls back to the enclosure, so a failure here costs nothing.

Results are cached in config/image-cache.json, keyed by article URL and
committed with the build, so each article is fetched once rather than once an
hour. Misses are cached too - for a shorter window, so a paywall that starts
answering is picked up again rather than written off forever.

Run:  scripts/harvest_images.py [--limit N] [--dry-run]
"""

from __future__ import annotations

import argparse
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
CACHE_PATH = ROOT / "config" / "image-cache.json"

# A hit is stable - the article's lead image rarely changes once published.
# A miss is worth retrying, because it is usually a timeout, a rate limit or a
# paywall interstitial rather than a genuine absence of any picture.
HIT_TTL = 90 * 24 * 3600
MISS_TTL = 7 * 24 * 3600

# Ceiling on new fetches per build, so a slow publisher cannot stall the hourly
# job. Anything not reached this run is simply retried next run.
DEFAULT_LIMIT = 400
WORKERS = 8
TIMEOUT = 8
# og:image lives in <head>; there is no reason to download the article body.
MAX_BYTES = 200_000

# Identifying the crawler is the polite minimum, and some publishers serve a
# stripped page to anything that looks like a default urllib client.
USER_AGENT = (
    "Mozilla/5.0 (compatible; liveboat-image-harvester/1.0; "
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
    frequently malformed <head> from an arbitrary publisher, we want six
    specific attributes out of it, and the standard library's parser is
    stricter about that than it needs to be here.
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
        scheme = urlsplit(absolute).scheme
        # An http image on an https page is blocked as mixed content, so it is
        # no more use to us than no image at all.
        if scheme == "https":
            return absolute
    return ""


def fetch_image(url: str) -> str:
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
            ctype = (response.headers.get("Content-Type") or "").lower()
            if "html" not in ctype:
                return ""
            raw = response.read(MAX_BYTES)
            charset = response.headers.get_content_charset() or "utf-8"
        return pick_image(raw.decode(charset, "replace"), url)
    except Exception:
        # Any failure - timeout, 403, TLS, redirect loop, bad encoding - is the
        # same outcome to the reader: this article keeps its typographic
        # treatment. Cached as a miss and retried in a week.
        return ""


def load_cache() -> dict:
    try:
        with CACHE_PATH.open(encoding="utf-8") as handle:
            cache = json.load(handle)
        return cache if isinstance(cache, dict) else {}
    except (OSError, ValueError):
        return {}


def save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(cache, handle, indent=1, sort_keys=True)
        handle.write("\n")
    tmp.replace(CACHE_PATH)


def cached_image(cache: dict, url: str, now: float) -> str | None:
    """The cached image for `url`, "" for a cached miss, None if unknown."""
    entry = cache.get(url)
    if not isinstance(entry, dict):
        return None
    image = entry.get("img") or ""
    ttl = HIT_TTL if image else MISS_TTL
    if now - entry.get("ts", 0) > ttl:
        return None
    return image


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
        print(f"harvest_images: no {FEED_DIR}, nothing to do")
        return 0

    now = time.time()
    cache = load_cache()

    # Archives hold the same articles the live feeds already carried, so
    # harvesting the live files covers them once the cache is warm.
    feed_files = sorted(
        path for path in FEED_DIR.glob("*.json") if not path.name.endswith("_archive.json")
    )

    feeds = []
    wanted: list[str] = []
    seen: set[str] = set()
    for path in feed_files:
        try:
            with path.open(encoding="utf-8") as handle:
                feed = json.load(handle)
        except (OSError, ValueError) as error:
            print(f"harvest_images: skipping {path.name}: {error}", file=sys.stderr)
            continue
        feeds.append((path, feed))
        for item in feed.get("items") or []:
            url = (item.get("url") or "").strip()
            if not url or url in seen or has_enclosure_image(item):
                continue
            seen.add(url)
            if cached_image(cache, url, now) is None:
                wanted.append(url)

    to_fetch = wanted[: max(args.limit, 0)]
    print(
        f"harvest_images: {len(seen)} articles without an enclosure image, "
        f"{len(wanted)} not cached, fetching {len(to_fetch)}"
    )

    if args.dry_run:
        for url in to_fetch[:20]:
            print("  would fetch", url)
        return 0

    if to_fetch:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for url, image in zip(to_fetch, pool.map(fetch_image, to_fetch)):
                cache[url] = {"img": image, "ts": int(now)}

    # Forget articles that have aged out of every feed, so the cache tracks the
    # feeds rather than growing forever.
    for url in [url for url in cache if url not in seen]:
        del cache[url]

    applied = 0
    for path, feed in feeds:
        changed = False
        for item in feed.get("items") or []:
            url = (item.get("url") or "").strip()
            if not url or has_enclosure_image(item):
                continue
            image = cached_image(cache, url, now)
            if image:
                item["lbImage"] = image
                applied += 1
                changed = True
        if changed:
            # Match liveboat's own output exactly - compact, raw UTF-8 - so the
            # only thing in the diff is the field we added.
            with path.open("w", encoding="utf-8") as handle:
                json.dump(feed, handle, ensure_ascii=False, separators=(",", ":"))

    save_cache(cache)

    resolved = sum(1 for entry in cache.values() if entry.get("img"))
    print(
        f"harvest_images: {applied} items given an image, "
        f"{resolved}/{len(cache)} cached urls resolved"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
