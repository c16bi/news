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

if 'href="./assets/custom.css' not in html:
    html = re.sub(
        r'(<link rel="stylesheet" href="\./assets/index\.css[^>]*>)',
        r'\1\n    <link rel="stylesheet" href="./assets/custom.css?bt={{build_time}}">',
        html,
        count=1,
    )

if "fonts.googleapis.com" not in html:
    font = (
        "\n\n"
        "    <!--\n"
        "      Playfair carries the two newsprint layouts and nothing else, so it is\n"
        "      requested with display=swap and a real fallback stack behind it: the page\n"
        "      renders immediately in Iowan / Palatino / Noto Serif, and stays readable\n"
        "      offline or if fonts.gstatic.com is blocked, where it simply never swaps.\n"
        "    -->\n"
        '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        '    <link rel="stylesheet" media="print" onload="this.media=\'all\'"\n'
        '          href="https://fonts.googleapis.com/css2?family=Playfair+Display'
        ':wght@600;700&display=swap">'
    )
    html = re.sub(
        r'(<link rel="stylesheet" href="\./assets/custom\.css[^>]*>)',
        lambda m: m.group(1) + font,
        html,
        count=1,
    )

if "serviceWorker" not in html:
    recovery = (
        "\n"
        "    <!--\n"
        "      Service worker recovery. This lives inline in the HTML on purpose: the\n"
        "      page is served network-first, so this snippet is always the newest code\n"
        "      even when the worker is handing out a stale cached custom.js. Asking the\n"
        "      registration to update, and reloading the moment a new worker claims the\n"
        "      page, is what rescues a browser pinned to an old build - the cached\n"
        "      bundle cannot rescue itself.\n"
        "    -->\n"
        "    <script>\n"
        "      (function () {\n"
        '        if (!("serviceWorker" in navigator)) return;\n'
        "        var reloaded = false;\n"
        '        navigator.serviceWorker.addEventListener("controllerchange", function () {\n'
        "          if (reloaded) return;\n"
        "          reloaded = true;\n"
        "          location.reload();\n"
        "        });\n"
        "        navigator.serviceWorker.getRegistration().then(function (reg) {\n"
        "          if (reg) reg.update();\n"
        "        }).catch(function () {});\n"
        "      })();\n"
        "    </script>"
    )
    html = html.replace(
        '<div id="app"></div>', '<div id="app"></div>\n' + recovery, 1
    )

if 'src="./assets/custom.js' not in html:
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
    n
    for n in (
        'href="./assets/custom.css',
        'src="./assets/custom.js',
        'rel="manifest"',
        "controllerchange",
        "fonts.googleapis.com",
    )
    if n not in html
]
if missing:
    sys.exit("error: failed to inject " + ", ".join(missing) + " into index.hbs")
PY

echo "templates/custom re-synced from templates/default (overrides preserved)."
