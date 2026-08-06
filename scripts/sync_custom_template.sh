#!/usr/bin/env bash
#
# Re-sync templates/custom from templates/default after a Liveboat update.
#
# `make update` overwrites templates/default with whatever ships upstream. This
# script copies that fresh output into templates/custom and re-applies the tags
# that pull in our override layer, so upgrading is:
#
#   make update && ./scripts/sync_custom_template.sh
#
# Our own files (the CSS/JS override layer, the service worker, the web app
# manifest and the 512px icon) are preserved untouched.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/templates/default"
DST="$ROOT/templates/custom"

if [ ! -d "$SRC" ]; then
  echo "error: $SRC does not exist" >&2
  exit 1
fi

# Files we own, relative to the template root. Anything listed here survives.
OURS=(
  "include/assets/custom.css"
  "include/assets/custom.js"
  "include/assets/site.webmanifest"
  "include/assets/android-chrome-512x512.png"
  "include/sw.js"
  "config.toml"
)

for f in "${OURS[@]}"; do
  if [ ! -f "$DST/$f" ]; then
    echo "error: $DST/$f is missing - nothing to preserve" >&2
    exit 1
  fi
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for f in "${OURS[@]}"; do
  mkdir -p "$tmp/$(dirname "$f")"
  cp "$DST/$f" "$tmp/$f"
done

rm -rf "$DST"
cp -r "$SRC" "$DST"

for f in "${OURS[@]}"; do
  mkdir -p "$DST/$(dirname "$f")"
  cp "$tmp/$f" "$DST/$f"
done

python3 - "$DST/index.hbs" <<'PY'
import re
import sys

path = sys.argv[1]
html = open(path, encoding="utf-8").read()

head_extras = (
    '    <link rel="manifest" href="./assets/site.webmanifest">\n'
    '    <meta name="theme-color" content="{{template_settings.background-color}}">\n'
    '    <meta name="color-scheme" content="dark light">\n'
    '    <meta property="og:title" content="{{ options.title }}">\n'
    '    <meta property="og:type" content="website">\n'
    '    <meta property="og:description" content="{{ options.title }} — a personal news feed.">\n\n'
)

if 'rel="manifest"' not in html:
    html = re.sub(
        r'(    <link rel="stylesheet" href="\./assets/index\.css[^>]*>)',
        head_extras + r"\1",
        html,
        count=1,
    )

if "custom.css" not in html:
    html = re.sub(
        r'(<link rel="stylesheet" href="\./assets/index\.css[^>]*>)',
        r'\1\n    <link rel="stylesheet" href="./assets/custom.css?bt={{build_time}}">',
        html,
        count=1,
    )

if "custom.js" not in html:
    block = (
        "<!--\n"
        "      custom.js is a classic script so it runs before the deferred module\n"
        "      below: it needs to wrap `fetch` before the SPA issues its first request.\n"
        "    -->\n"
        '    <script src="./assets/custom.js?bt={{build_time}}"></script>\n'
        "    "
    )
    html = re.sub(
        r'(?=<script type="module" src="\./assets/index\.js)',
        block.replace("\\", "\\\\"),
        html,
        count=1,
    )

open(path, "w", encoding="utf-8").write(html)

missing = [
    n for n in ("custom.css", "custom.js", 'rel="manifest"') if n not in html
]
if missing:
    sys.exit("error: failed to inject " + ", ".join(missing) + " into index.hbs")
PY

echo "templates/custom re-synced from templates/default (overrides preserved)."
