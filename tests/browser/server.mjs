/*
 * server.mjs - serve the rendered test site the way GitHub Pages serves the
 * real one: under /news/, with an SPA-free 404.
 *
 * Two test-only additions:
 *   /news/__mock/img/<name>  a generated picture, so picture layouts and
 *                            offline caching can be tested without any
 *                            publisher's CDN
 *   /__hits                  how many times each path was requested since the
 *                            last /__hits/reset - the only honest way to prove
 *                            a revisit downloads less is to count at the server
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { picture } from "./picture.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./.site/", import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
};

let hits = new Map();

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  if (path === "/__hits") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(Object.fromEntries(hits)));
  }
  if (path === "/__hits/reset") {
    hits = new Map();
    res.writeHead(204);
    return res.end();
  }
  if (!path.startsWith("/news/")) {
    res.writeHead(302, { Location: "/news/" });
    return res.end();
  }
  hits.set(path, (hits.get(path) || 0) + 1);

  if (path.startsWith("/news/__mock/img/")) {
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    return res.end(picture(path));
  }

  let rel = path.slice("/news/".length) || "index.html";
  if (rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    // Like GitHub Pages: cacheable for a short while, so the content hashes in
    // the river URLs are what keeps a revisit cheap, not a disabled cache.
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      "Cache-Control": "max-age=600",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
});

server.listen(PORT, () =>
  console.log(`test site on http://localhost:${PORT}/news/`),
);
