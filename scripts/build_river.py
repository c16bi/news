#!/usr/bin/env python3
"""
build_river.py - one merged feed, split by day, for the front end to load.

Liveboat writes one JSON file per feed. Loaded as-is, a visit after any hourly
rebuild downloaded all of it again - 1.1 MB compressed - for three reasons
measured on consecutive builds:

  - Every file changed every build, even with nothing new in it. Each item's
    `guid` is a row number in newsboat's cache database, which the build
    recreates from scratch, so 599 untouched articles were renumbered in a
    single build.
  - The five topic feeds (Finance, News, Tech, Politics, Sport) re-package the
    source feeds' items: 451 KB of the download was the same articles twice.
  - Every `_archive` file held exactly the same items as its live feed.

So this reads only the source feeds, merges them, drops the unstable fields,
and writes the result one file per UTC day under docs/river/. A day that has
not changed produces the same bytes and the same hash, so its URL is the same
and the browser already has it. After a rebuild a visit fetches today, any day
a publisher edited, and the small index - not the whole feed.

It also does at build time what the front end used to redo on every visit:
picks each article's picture, flattens its text out of HTML (the front end
never has to handle publisher markup), and groups the same story across
outlets (see stories.py).

Output, all under docs/river/:
  index.json          feeds, the list of days with a content hash for each,
                      and hashes for clusters.json and icons
  YYYY-MM-DD.json     that day's articles, newest first
  clusters.json       groups of URLs reporting the same story

The raw docs/feeds/*.json files are left exactly as Liveboat wrote them, so
anything else reading them (the RSS and OPML exports are separate files and
unaffected) keeps working.

Run:  scripts/build_river.py
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stories  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
FEED_DIR = DOCS / "feeds"
OUT_DIR = DOCS / "river"
# Committed with each build like the other caches in config/, so it carries
# from one hourly run to the next.
IMAGE_CACHE = ROOT / "config" / "river-images.json"

FORMAT_VERSION = 1

# Long enough to hold every full article the four syndicating sources send;
# short enough that one longread cannot dominate a day's file.
MAX_TEXT = 12_000

IMAGE_RE = re.compile(r"\.(jpe?g|png|webp|avif|gif)(\?|#|$)", re.I)
TAG_RE = re.compile(r"<[^>]+>")
BLOCK_END_RE = re.compile(r"</(p|div|li|h[1-6]|blockquote|tr)\s*>|<br\s*/?>", re.I)
STRIP_RE = re.compile(
    r"<(script|style|noscript|svg|figure|figcaption|iframe|template)\b[^>]*>.*?</\1\s*>",
    re.I | re.S,
)


def unescape_fully(value: str) -> str:
    """Undo entity escaping however many times a publisher applied it.

    57 picture URLs in the live feed arrived as `&amp;amp;`, so the browser
    asked for a query string that does not exist and the picture never loaded.
    """
    for _ in range(4):
        decoded = html.unescape(value)
        if decoded == value:
            break
        value = decoded
    return value


def clean_title(raw: str) -> str:
    return re.sub(r"\s+", " ", TAG_RE.sub(" ", unescape_fully(raw or ""))).strip()


def text_from_html(markup: str) -> str:
    """Paragraphs of plain text from a feed's HTML content."""
    if not markup:
        return ""
    body = STRIP_RE.sub(" ", markup)
    body = BLOCK_END_RE.sub("\n\n", body)
    paragraphs = []
    for chunk in body.split("\n\n"):
        line = re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", chunk))).strip()
        if line:
            paragraphs.append(line)
    return "\n\n".join(paragraphs)


def cap(text: str, limit: int = MAX_TEXT) -> str:
    if len(text) <= limit:
        return text
    cut = text.rfind("\n\n", 0, limit)
    return (text[:cut] if cut > limit // 2 else text[:limit]).rstrip() + "…"


def safe_url(raw: str, *, allow_http: bool = False) -> str:
    """The URL if it is one the page may safely use, else "".

    Article links end up in an href and pictures in a src; a feed that sent
    `javascript:` or `data:` must not get either.
    """
    url = unescape_fully((raw or "").strip())
    if url.startswith("https://"):
        return url
    if allow_http and url.startswith("http://"):
        return url
    return ""


def pick_image(item: dict) -> str:
    # https only: an http picture on this https page is blocked as mixed
    # content, so it is no more use than none.
    harvested = safe_url(item.get("lbImage") or "")
    if harvested:
        return harvested
    enclosure = safe_url(item.get("enclosureUrl") or "")
    if not enclosure:
        return ""
    if (item.get("enclosureMime") or "").startswith("image/"):
        return enclosure
    return enclosure if IMAGE_RE.search(enclosure) else ""


def pick_text(item: dict) -> str:
    """The best text available: harvested body, else the feed's own copy."""
    harvested = (item.get("lbText") or "").strip()
    own = text_from_html(item.get("content") or "")
    best = harvested if len(harvested) > len(own) else own
    return cap(best)


def steady_image(article_url: str, image: str, previous: dict[str, str]) -> str:
    """The image URL this article had last build, if it is the same picture.

    Autosport's CDN serves each picture from a different numbered host on
    every request (cdn-6.motorsport.com one hour, cdn-8 the next), so its
    image URLs changed every build - and with them every day file holding an
    Autosport story, which is most of the last nine days. Same path on another
    host, or the same path with a rotated query string, is the same picture:
    keep the URL the reader already has. A different path is a different
    picture and is taken.
    """
    before = previous.get(article_url)
    if not before or not image or before == image:
        return image
    if urlsplit(before).path == urlsplit(image).path:
        return before
    return image


def load_image_cache(path: Path) -> dict[str, str]:
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
        return {k: v for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_image_cache(path: Path, cache: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(cache, handle, ensure_ascii=False, indent=0, sort_keys=True)
        handle.write("\n")
    tmp.replace(path)


def utc_day(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def dumps(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def load_feeds(feed_dir: Path) -> list[dict]:
    feeds = []
    for path in sorted(feed_dir.glob("*.json")):
        if path.name.endswith("_archive.json") or path.name in ("icons.json", "feeds.json"):
            continue
        try:
            with path.open(encoding="utf-8") as handle:
                feed = json.load(handle)
        except (OSError, ValueError) as error:
            print(f"build_river: skipping {path.name}: {error}", file=sys.stderr)
            continue
        if isinstance(feed, dict) and isinstance(feed.get("items"), list):
            feeds.append(feed)
    return feeds


def build(docs: Path, now: float | None = None, image_cache: Path | None = None) -> dict:
    """Write docs/river/ from docs/feeds/ and return the index."""
    feed_dir = docs / "feeds"
    out_dir = docs / "river"
    now = time.time() if now is None else now
    image_cache = IMAGE_CACHE if image_cache is None else image_cache
    previous_images = load_image_cache(image_cache)
    images_now: dict[str, str] = {}

    try:
        built = int((docs / "build_time.txt").read_text().strip())
    except (OSError, ValueError):
        built = int(now)

    feeds = load_feeds(feed_dir)
    sources = [
        f for f in feeds if not f.get("isQuery") and not f.get("isHidden") and not f.get("isEmpty")
    ]

    meta: dict[str, dict] = {}
    articles: dict[str, dict] = {}

    for feed in sources:
        fid = str(feed.get("id") or "")
        if not fid:
            continue
        meta[fid] = {
            "title": feed.get("displayTitle") or feed.get("title") or "",
            "tags": [t for t in feed.get("tags") or [] if isinstance(t, str)],
            "link": safe_url(feed.get("feedLink") or "", allow_http=True),
        }
        for item in feed["items"]:
            url = safe_url(item.get("url") or "", allow_http=True)
            title = clean_title(item.get("title") or "")
            if not url or not title or url in articles:
                continue
            date = int(item.get("date") or 0)
            # A publisher clock running ahead must not pin a story to the top.
            if date <= 0 or date > built + 3600:
                date = built
            record = {"url": url, "title": title, "date": date, "feed": fid}
            author = clean_title(item.get("author") or "")
            if author:
                record["author"] = author
            image = steady_image(url, pick_image(item), previous_images)
            if image:
                record["image"] = image
                images_now[url] = image
            text = pick_text(item)
            if text:
                record["text"] = text
            articles[url] = record

    ordered = sorted(articles.values(), key=lambda a: (-a["date"], a["url"]))

    by_day: dict[str, list[dict]] = {}
    for article in ordered:
        by_day.setdefault(utc_day(article["date"]), []).append(article)

    out_dir.mkdir(parents=True, exist_ok=True)
    written: set[str] = set()

    def write(name: str, data: bytes) -> None:
        target = out_dir / name
        # Leave an unchanged file untouched, so the commit is quiet as well as
        # the download.
        if not target.exists() or target.read_bytes() != data:
            tmp = target.with_suffix(".tmp")
            tmp.write_bytes(data)
            tmp.replace(target)
        written.add(name)

    days = []
    for day in sorted(by_day, reverse=True):
        data = dumps(by_day[day])
        write(f"{day}.json", data)
        days.append({"day": day, "v": digest(data), "n": len(by_day[day])})

    groups = stories.cluster(ordered)
    clusters_bytes = dumps(groups)
    write("clusters.json", clusters_bytes)

    icons_path = feed_dir / "icons.json"
    icons_v = digest(icons_path.read_bytes()) if icons_path.exists() else ""

    index = {
        "format": FORMAT_VERSION,
        "built": built,
        "feeds": meta,
        "days": days,
        "clusters": {"v": digest(clusters_bytes), "n": len(groups)},
        "icons": {"v": icons_v},
    }
    write("index.json", dumps(index))

    for stale in out_dir.glob("*.json"):
        if stale.name not in written:
            stale.unlink()
    for tmp in out_dir.glob("*.tmp"):
        tmp.unlink()

    # Only articles still in the feed, so the cache tracks it rather than grows.
    if images_now != previous_images:
        save_image_cache(image_cache, images_now)

    return index


def main() -> int:
    if not FEED_DIR.is_dir():
        print(f"build_river: no {FEED_DIR}, nothing to do")
        return 0
    index = build(DOCS)
    total = sum(d["n"] for d in index["days"])
    print(
        f"build_river: {total} articles from {len(index['feeds'])} sources "
        f"across {len(index['days'])} days; {index['clusters']['n']} stories "
        f"reported by more than one outlet"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
