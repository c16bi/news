#!/usr/bin/env python3
"""
report_empty_feeds.py - name the configured sources that produced nothing.

A feed whose URL has rotted does not announce itself. newsboat fetches it,
gets nothing usable, and liveboat writes no page for it; the site simply shows
one fewer source than the config lists. Four sources had been dead for an
unknown length of time before anyone noticed - the AP feeds were still pointing
at endpoints AP had retired.

So after each build this compares what config/urls asks for against what
docs/feeds actually contains, and prints a GitHub Actions warning for anything
missing or empty. It never fails the build: a publisher having a bad morning is
not a reason to stop publishing the page.

Run:  scripts/report_empty_feeds.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URLS_PATH = ROOT / "config" / "urls"
FEED_DIR = ROOT / "docs" / "feeds"

# A source line is a URL, then a "~Display Name" in quotes, then tags. Query
# lines ("query:...") are saved searches over the others, not sources.
SOURCE_RE = re.compile(r'^\s*(?P<url>https?://\S+)\s+"~(?P<name>[^"]+)"')


def configured() -> list[tuple[str, str]]:
    if not URLS_PATH.is_file():
        return []
    out = []
    for line in URLS_PATH.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith("#"):
            continue
        match = SOURCE_RE.match(line)
        if match:
            out.append((match.group("name"), match.group("url")))
    return out


def built() -> dict[str, int]:
    counts: dict[str, int] = {}
    if not FEED_DIR.is_dir():
        return counts
    for path in FEED_DIR.glob("*.json"):
        if path.name.endswith("_archive.json"):
            continue
        try:
            with path.open(encoding="utf-8") as handle:
                feed = json.load(handle)
        except (OSError, ValueError):
            continue
        if not isinstance(feed, dict) or feed.get("isQuery"):
            continue
        name = feed.get("displayTitle") or feed.get("title")
        if name:
            counts[name] = len(feed.get("items") or [])
    return counts


def main() -> int:
    sources = configured()
    if not sources:
        print("report_empty_feeds: no sources found in config/urls")
        return 0

    counts = built()
    dead = [(name, url) for name, url in sources if counts.get(name, 0) == 0]

    for name, url in dead:
        # ::warning:: surfaces on the run summary rather than only in the log.
        print(f"::warning title=Empty feed::{name} produced no items - {url}")

    live = len(sources) - len(dead)
    print(f"report_empty_feeds: {live}/{len(sources)} sources produced items")
    for name, _ in sorted(sources, key=lambda s: -counts.get(s[0], 0)):
        print(f"  {counts.get(name, 0):4}  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
