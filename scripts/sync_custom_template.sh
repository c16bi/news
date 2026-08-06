#!/usr/bin/env bash
#
# Re-sync templates/custom from templates/default after a Liveboat update.
#
# `make update` overwrites templates/default with whatever ships upstream. This
# script copies that fresh output into templates/custom and re-applies the two
# lines that pull in our override layer, so upgrading is:
#
#   make update && ./scripts/sync_custom_template.sh
#
# custom.css / custom.js are ours and are never touched.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/templates/default"
DST="$ROOT/templates/custom"

if [ ! -d "$SRC" ]; then
  echo "error: $SRC does not exist" >&2
  exit 1
fi

for f in custom.css custom.js; do
  if [ ! -f "$DST/include/assets/$f" ]; then
    echo "error: $DST/include/assets/$f is missing - nothing to preserve" >&2
    exit 1
  fi
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp "$DST/include/assets/custom.css" "$DST/include/assets/custom.js" "$tmp/"
cp "$DST/config.toml" "$tmp/config.toml"

rm -rf "$DST"
cp -r "$SRC" "$DST"

cp "$tmp/custom.css" "$tmp/custom.js" "$DST/include/assets/"
cp "$tmp/config.toml" "$DST/config.toml"

python3 - "$DST/index.hbs" <<'PY'
import re
import sys

path = sys.argv[1]
html = open(path, encoding="utf-8").read()

head_extras = (
    '    <meta name="theme-color" content="{{template_settings.background-color}}">\n'
    '    <meta name="color-scheme" content="dark light">\n'
    '    <meta property="og:title" content="{{ options.title }}">\n'
    '    <meta property="og:type" content="website">\n'
    '    <meta property="og:description" content="{{ options.title }} — a personal news feed.">\n\n'
)

if 'name="theme-color"' not in html:
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

missing = [n for n in ("custom.css", "custom.js") if n not in html]
if missing:
    sys.exit("error: failed to inject " + ", ".join(missing) + " into index.hbs")
PY

echo "templates/custom re-synced from templates/default (overrides preserved)."
