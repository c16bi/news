#!/usr/bin/env python3
"""
harvest_icons.py - find each publisher's real logo.

The browser was guessing. It tried /apple-touch-icon.png, then
/apple-touch-icon-precomposed.png, then /favicon.ico, and took the first that
loaded at 32px or better. That works for sites which happen to keep an icon at
one of those three paths and fails silently everywhere else, which is why most
sources still show a coloured monogram: publishers overwhelmingly declare their
icon in the page head and serve it from a CDN path no one could guess.

So this reads what they actually declare. One request per domain - not per
article - for the site root, then <link rel="icon">, "apple-touch-icon" and
"shortcut icon" out of the head, largest declared size first. Results go to
docs/feeds/icons.json for the front end and are cached in config/icon-cache.json
so a domain is fetched once rather than once an hour.

Publishers that refuse the build - Bloomberg, the FT and the Economist all
block datacentre addresses - are recorded as a miss and keep their monogram.
The front end still probes from the browser, which they do not block, so those
can resolve there instead.

Run:  scripts/harvest_icons.py [--limit N] [--dry-run]
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
CACHE_PATH = ROOT / "config" / "icon-cache.json"
OUT_PATH = FEED_DIR / "icons.json"

# A publisher's logo changes about never; a miss is usually a block or a
# timeout and is worth retrying sooner.
HIT_TTL = 180 * 24 * 3600
MISS_TTL = 14 * 24 * 3600

WORKERS = 6
TIMEOUT = 8
MAX_BYTES = 200_000
DEFAULT_LIMIT = 60

USER_AGENT = (
    "Mozilla/5.0 (compatible; liveboat-icon-harvester/1.0; "
    "+https://github.com/c16bi/news)"
)

LINK_RE = re.compile(r"<link\b[^>]*>", re.I)
ATTR_RE = re.compile(
    r"""(rel|href|sizes|type)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))""",
    re.I,
)

# Anything below this is worse than the monogram at chip size.
MIN_SIZE = 32
# What we would pick if a site declared everything: a touch icon is a real
# logo at a usable size, where a bare "icon" is often a 16px glyph.
REL_RANK = {
    "apple-touch-icon": 3,
    "apple-touch-icon-precomposed": 3,
    "icon": 2,
    "shortcut icon": 1,
}


def parse_size(raw: str) -> int:
    """Largest edge declared in a sizes attribute, 0 if unusable."""
    best = 0
    for token in (raw or "").split():
        if token.lower() == "any":
            # An SVG: scales to anything, so treat it as the best case.
            return 1024
        match = re.match(r"(\d+)\s*[xX]\s*(\d+)$", token)
        if match:
            best = max(best, int(match.group(1)), int(match.group(2)))
    return best


def candidates(html: str, page_url: str) -> list[tuple[int, int, str]]:
    """(rel rank, pixel size, absolute url) for every icon the page declares."""
    out = []
    for tag in LINK_RE.findall(html):
        attrs = {}
        for name, _, dq, sq, bare in ATTR_RE.findall(tag):
            attrs[name.lower()] = dq or sq or bare
        rels = (attrs.get("rel") or "").strip().lower()
        if "icon" not in rels:
            continue
        href = (attrs.get("href") or "").strip()
        if not href or href.startswith("data:"):
            continue

        rank = 0
        for rel, value in REL_RANK.items():
            if rel in rels:
                rank = max(rank, value)
        if not rank:
            continue

        size = parse_size(attrs.get("sizes", ""))
        if (attrs.get("type") or "").lower() == "image/svg+xml":
            size = max(size, 1024)

        absolute = urljoin(page_url, href)
        # An http icon on an https page is blocked as mixed content.
        if urlsplit(absolute).scheme != "https":
            continue
        out.append((rank, size, absolute))
    return out


def pick(html: str, page_url: str) -> str:
    found = candidates(html, page_url)
    if not found:
        return ""
    # Prefer a declared size at or above the chip size; otherwise take the
    # best-ranked one and let the browser decide whether it is usable.
    sized = [c for c in found if c[1] >= MIN_SIZE]
    pool = sized or found
    pool.sort(key=lambda c: (c[0], c[1]), reverse=True)
    return pool[0][2]


def fetch_icon(domain: str) -> str:
    url = "https://" + domain + "/"
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
                return ""
            raw = response.read(MAX_BYTES)
            charset = response.headers.get_content_charset() or "utf-8"
            final = response.geturl()
        return pick(raw.decode(charset, "replace"), final)
    except Exception:
        # A block, a timeout, a redirect loop: the reader sees a monogram.
        return ""


def load_cache() -> dict:
    try:
        with CACHE_PATH.open(encoding="utf-8") as handle:
            cache = json.load(handle)
        return cache if isinstance(cache, dict) else {}
    except (OSError, ValueError):
        return {}


def cached(cache: dict, domain: str, now: float) -> str | None:
    entry = cache.get(domain)
    if not isinstance(entry, dict):
        return None
    icon = entry.get("url") or ""
    if now - entry.get("ts", 0) > (HIT_TTL if icon else MISS_TTL):
        return None
    return icon


def domains_in_feeds() -> list[str]:
    seen = {}
    if not FEED_DIR.is_dir():
        return []
    for path in sorted(FEED_DIR.glob("*.json")):
        if path.name.endswith("_archive.json") or path.name == "icons.json":
            continue
        try:
            with path.open(encoding="utf-8") as handle:
                feed = json.load(handle)
        except (OSError, ValueError):
            continue
        for item in feed.get("items") or []:
            host = urlsplit((item.get("url") or "").strip()).netloc.lower()
            if host.startswith("www."):
                host = host[4:]
            if host:
                seen[host] = seen.get(host, 0) + 1
    # Busiest first, so a truncated run still covers what is most on screen.
    return sorted(seen, key=lambda d: -seen[d])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    domains = domains_in_feeds()
    if not domains:
        print("harvest_icons: no feeds, nothing to do")
        return 0

    now = time.time()
    cache = load_cache()
    wanted = [d for d in domains if cached(cache, d, now) is None]
    to_fetch = wanted[: max(args.limit, 0)]

    print(
        f"harvest_icons: {len(domains)} domains, "
        f"{len(wanted)} not cached, fetching {len(to_fetch)}"
    )
    if args.dry_run:
        for d in to_fetch:
            print("  would fetch", d)
        return 0

    if to_fetch:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for domain, icon in zip(to_fetch, pool.map(fetch_icon, to_fetch)):
                cache[domain] = {"url": icon, "ts": int(now)}

    for domain in [d for d in cache if d not in set(domains)]:
        del cache[domain]

    icons = {d: cache[d]["url"] for d in domains if (cache.get(d) or {}).get("url")}

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CACHE_PATH.open("w", encoding="utf-8") as handle:
        json.dump(cache, handle, indent=1, sort_keys=True)
        handle.write("\n")
    FEED_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as handle:
        json.dump(icons, handle, ensure_ascii=False, separators=(",", ":"))

    print(f"harvest_icons: {len(icons)}/{len(domains)} domains have a logo")
    for domain in domains:
        mark = "ok " if icons.get(domain) else "-- "
        print(f"  {mark} {domain}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
