#!/usr/bin/env python3
"""
render_site.py - build a runnable copy of the site without Liveboat.

The real build needs newsboat, the Liveboat binary and the network. Tests need
none of those: they need the page exactly as the build would emit it, over
fixed data. So this does the two things Liveboat does that matter to the front
end - copy templates/custom/include/ into the output and render index.hbs - and
then runs the same scripts/build_river.py the workflow runs.

index.hbs uses a small, fixed subset of Handlebars ({{x}}, {{#if}},
{{#unless}}, {{#each}}, this, dotted paths), and that subset is implemented
here. If the template ever needs more, this fails loudly rather than rendering
something subtly different from production.

Usage:  tests/render_site.py <data-dir> <out-dir>

<data-dir> holds feeds/*.json (Liveboat's per-feed output), and optionally
feeds/icons.json and build_time.txt.
"""

from __future__ import annotations

import html
import json
import re
import shutil
import sys
import tempfile
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "templates" / "custom"
SITE_PATH = "/news/"
TITLE = "Benji's News"

sys.path.insert(0, str(ROOT / "scripts"))
import build_river  # noqa: E402

TAG_RE = re.compile(r"\{\{\{\s*(.+?)\s*\}\}\}|\{\{\s*([#/]?)([^}]*?)\s*\}\}")


def parse(src: str):
    """Template text -> nested list of nodes."""
    root: list = []
    stack = [(None, root)]
    pos = 0
    for m in TAG_RE.finditer(src):
        stack[-1][1].append(("text", src[pos : m.start()]))
        pos = m.end()
        if m.group(1) is not None:
            stack[-1][1].append(("raw", m.group(1).strip()))
            continue
        kind, body = m.group(2), m.group(3).strip()
        if kind == "#":
            name, _, arg = body.partition(" ")
            if name not in ("if", "unless", "each"):
                raise ValueError("unsupported block helper: " + name)
            node = (name, arg.strip(), [])
            stack[-1][1].append(node)
            stack.append((name, node[2]))
        elif kind == "/":
            if stack[-1][0] != body:
                raise ValueError("mismatched {{/%s}}" % body)
            stack.pop()
        else:
            stack[-1][1].append(("var", body))
    stack[-1][1].append(("text", src[pos:]))
    if len(stack) != 1:
        raise ValueError("unclosed block: " + str(stack[-1][0]))
    return root


def lookup(path: str, scopes: list):
    parts = path.split(".")
    if parts[0] == "this":
        value = scopes[-1]
        parts = parts[1:]
    else:
        value = None
        for scope in reversed(scopes):
            if isinstance(scope, dict) and parts[0] in scope:
                value = scope
                break
        if value is None:
            return None
    for part in parts:
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def show(value) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    return "" if value is None else str(value)


def truthy(value) -> bool:
    return bool(value) and value not in ("false",)


def render(nodes, scopes) -> str:
    out = []
    for node in nodes:
        kind = node[0]
        if kind == "text":
            out.append(node[1])
        elif kind == "var":
            out.append(html.escape(show(lookup(node[1], scopes)), quote=True))
        elif kind == "raw":
            out.append(show(lookup(node[1], scopes)))
        elif kind == "if":
            if truthy(lookup(node[1], scopes)):
                out.append(render(node[2], scopes))
        elif kind == "unless":
            if not truthy(lookup(node[1], scopes)):
                out.append(render(node[2], scopes))
        elif kind == "each":
            for item in lookup(node[1], scopes) or []:
                out.append(render(node[2], scopes + [item]))
    return "".join(out)


def feed_list(feed_dir: Path) -> list[dict]:
    feeds = []
    for path in sorted(feed_dir.glob("*.json")):
        if path.name.endswith("_archive.json") or path.name in ("icons.json", "feeds.json"):
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        feeds.append(
            {
                "id": data["id"],
                "title": data.get("title", ""),
                "displayTitle": data.get("displayTitle", ""),
                "feedLink": data.get("feedLink", ""),
                "isQuery": bool(data.get("isQuery")),
                "isEmpty": bool(data.get("isEmpty")),
                "isHidden": bool(data.get("isHidden")),
                "tags": data.get("tags", []),
            }
        )
    return feeds


def build(data_dir: Path, out: Path, river: bool = True) -> Path:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(TEMPLATE / "include", out)
    shutil.copytree(data_dir / "feeds", out / "feeds")
    build_time_file = data_dir / "build_time.txt"
    build_time = build_time_file.read_text().strip() if build_time_file.exists() else "1790000000"
    (out / "build_time.txt").write_text(build_time)

    config = tomllib.loads((TEMPLATE / "config.toml").read_text())
    context = {
        "options": {"title": TITLE, "site_path": SITE_PATH},
        "build_time": build_time,
        "template_version": config.get("version", ""),
        "template_settings": config.get("template_settings", {}),
        "feeds": feed_list(out / "feeds"),
    }
    template = parse((TEMPLATE / "index.hbs").read_text(encoding="utf-8"))
    (out / "index.html").write_text(render(template, [context]), encoding="utf-8")

    if river:
        with tempfile.TemporaryDirectory() as tmp:
            build_river.build(out, image_cache=Path(tmp) / "images.json")
    return out


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    out = build(Path(sys.argv[1]), Path(sys.argv[2]))
    print(f"render_site: wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
