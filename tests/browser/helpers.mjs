/* Shared setup for the browser tests. */

import { expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { picture } from "./picture.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const FIXTURES = join(HERE, "..", "fixtures");
export const SITE = join(HERE, ".site");

/* Publisher pictures and logos come from CDNs a test must not depend on.
   They are answered with a generated picture. That has to include requests
   the service worker makes on the page's behalf, whose resource type is
   "fetch" rather than "image" - refusing those is how an earlier version of
   this harness made every picture fail whenever the worker was running.
   Web fonts are refused, which the page has to survive anyway. */
export async function offline3rdParty(context) {
  await context.route(/^https?:\/\/(?!localhost)/, (route) => {
    const req = route.request();
    if (/fonts\.(googleapis|gstatic)\.com/.test(req.url()))
      return route.abort();
    return route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: picture(req.url()),
    });
  });
}

/* Load the page with chosen preferences already stored, as a returning
   reader would have them. Collects page errors for assertNoErrors(). */
export async function open(
  page,
  {
    layout = "compact",
    theme = "tokyo",
    prefs = {},
    saved,
    read,
    path = "",
  } = {},
) {
  await offline3rdParty(page.context());
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !/Failed to load resource|net::ERR/.test(m.text())
    )
      page.__errors.push(m.text());
  });
  await page.addInitScript(
    ([layout, theme, prefs, saved, read]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("liveboat-default-theme", theme);
      localStorage.setItem(
        "liveboat-custom:prefs",
        JSON.stringify({ layout, ...prefs }),
      );
      if (saved)
        localStorage.setItem("liveboat-custom:saved", JSON.stringify(saved));
      if (read)
        localStorage.setItem("liveboat-custom:read", JSON.stringify(read));
    },
    [layout, theme, prefs, saved || null, read || null],
  );
  await page.goto(path);
  await page.waitForFunction(() => window.__lb && window.__lb.ready);
}

export function assertNoErrors(page) {
  expect(page.__errors, page.__errors.join("\n")).toEqual([]);
}

/* A real touch drag, frame by frame - the gesture code listens for touch
   events, which a mouse drag never produces. */
export async function swipe(page, selector, dx) {
  await page.evaluate(
    async ([selector, dx]) => {
      const li = document.querySelector(selector);
      const r = li.getBoundingClientRect();
      const y = r.top + r.height - 10;
      const x0 = r.left + r.width / 2;
      const touch = (x) =>
        new Touch({ identifier: 1, target: li, clientX: x, clientY: y });
      const fire = (type, x) =>
        li.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: type === "touchend" ? [] : [touch(x)],
            targetTouches: type === "touchend" ? [] : [touch(x)],
            changedTouches: [touch(x)],
          }),
        );
      fire("touchstart", x0);
      for (let i = 1; i <= 14; i++) {
        fire("touchmove", x0 + (dx * i) / 14);
        await new Promise((r) => requestAnimationFrame(r));
      }
      fire("touchend", x0 + dx);
    },
    [selector, dx],
  );
}

export function stored(page, key) {
  return page.evaluate(
    (k) => JSON.parse(localStorage.getItem("liveboat-custom:" + k) || "{}"),
    key,
  );
}

/* Simulate an hourly rebuild: the fixture plus whatever `change` does to it,
   an hour later, built into the directory the server is serving. */
export function rebuild(change) {
  const data = mkdtempSync(join(tmpdir(), "news-fixture-"));
  cpSync(FIXTURES, data, { recursive: true });
  const built =
    Number(readFileSync(join(data, "build_time.txt"), "utf8")) + 3600;
  writeFileSync(join(data, "build_time.txt"), String(built));
  if (change) change(data, built);
  execFileSync("python3", [join(HERE, "..", "render_site.py"), data, SITE], {
    stdio: "pipe",
  });
  rmSync(data, { recursive: true, force: true });
  return built;
}

export function restoreSite() {
  execFileSync(
    "python3",
    [join(HERE, "..", "render_site.py"), FIXTURES, SITE],
    { stdio: "pipe" },
  );
}

/* Add one story to one source feed in a fixture directory. */
export function addStory(dataDir, story) {
  const file = join(dataDir, "feeds", story.feedFile);
  const feed = JSON.parse(readFileSync(file, "utf8"));
  feed.items.unshift({
    title: story.title,
    url: story.url,
    date: story.date,
    author: "",
    guid: 999999,
    unread: true,
    content: story.content || "",
    contentLength: 0,
    flags: "",
    enclosureUrl: story.image || "",
    enclosureMime: "",
    commentsUrl: "",
  });
  writeFileSync(file, JSON.stringify(feed));
}
