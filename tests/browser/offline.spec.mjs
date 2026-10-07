import { test, expect } from "@playwright/test";
import { open, assertNoErrors } from "./helpers.mjs";

test.use({ serviceWorkers: "allow" });

/* Pictures stay on their real publisher URLs here. The test routing answers
   them - including the requests the service worker itself makes - so inside
   the worker they arrive exactly as in production: cross-origin, opaque, with
   an unreadable body. An earlier version of this test used same-origin
   stand-ins, which are readable, and so missed that the worker was rejecting
   every real picture. */

async function readyWithWorker(page) {
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  // Once more, so everything on the page comes through the worker.
  await page.reload();
  await page.waitForFunction(() => window.__lb && window.__lb.ready);
}

async function scrollRows(page, count) {
  for (let i = 0; i < count; i += 4) {
    await page.locator("li.feed-item").nth(i).scrollIntoViewIfNeeded();
    await page.waitForTimeout(40);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

function picturesIn(page, count) {
  return page.evaluate((count) => {
    const rows = [...document.querySelectorAll("li.feed-item")].slice(0, count);
    const imgs = rows
      .map((li) => li.querySelector("img.lb-thumb"))
      .filter(Boolean);
    return {
      total: imgs.length,
      loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    };
  }, count);
}

const READ = 60; // rows scrolled past before going offline

test("the feed, the pictures you scrolled past and the articles survive losing the network", async ({
  page,
  context,
}) => {
  await open(page, { layout: "f1" });
  await readyWithWorker(page);
  await scrollRows(page, READ);
  await page.waitForTimeout(600);
  const online = await page.locator("li.feed-item").count();

  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.__lb && window.__lb.ready);
  await expect(page.locator("body")).toHaveClass(/lb-offline/);
  expect(await page.locator("li.feed-item").count()).toBe(online);

  await scrollRows(page, READ);
  await page.waitForTimeout(400);
  const pictures = await picturesIn(page, READ);
  expect(pictures.total).toBeGreaterThan(20);
  expect(
    pictures.loaded,
    "every picture scrolled past comes from the cache",
  ).toBe(pictures.total);

  // A full article still reads.
  await page.evaluate(() => {
    const item = window.__lb.data.items.find((i) => i.text.length > 800);
    window.__lb.sheet.open(item);
  });
  await expect(page.locator("#lb-sheet .lb-sheet-body")).toHaveClass(
    /lb-sheet-full/,
  );

  // And a tab opened cold, with no network at all.
  const cold = await context.newPage();
  await cold.goto("/news/");
  await cold.waitForFunction(() => window.__lb && window.__lb.ready);
  expect(await cold.locator("li.feed-item").count()).toBe(online);
  await context.setOffline(false);
  assertNoErrors(page);
});

test("cross-origin pictures are actually stored", async ({ page }) => {
  await open(page, { layout: "f1" });
  await readyWithWorker(page);
  await scrollRows(page, READ);
  await page.waitForTimeout(800);
  const stored = await page.evaluate(async () => {
    const name = (await caches.keys()).find((k) => k.endsWith("-img"));
    if (!name) return { entries: 0, crossOrigin: 0 };
    const keys = await (await caches.open(name)).keys();
    return {
      entries: keys.length,
      crossOrigin: keys.filter((r) => new URL(r.url).origin !== location.origin)
        .length,
    };
  });
  expect(stored.crossOrigin).toBeGreaterThan(20);
});

test("the picture cache stays within its cap", async ({ page }) => {
  await open(page, { layout: "f1" });
  await readyWithWorker(page);
  const rows = await page.locator("li.feed-item").count();
  await scrollRows(page, rows);
  await page.waitForTimeout(1500);
  const entries = await page.evaluate(async () => {
    const name = (await caches.keys()).find((k) => k.endsWith("-img"));
    return name ? (await (await caches.open(name)).keys()).length : 0;
  });
  expect(entries).toBeGreaterThan(50);
  expect(entries).toBeLessThanOrEqual(160);
});

test("a first visit loads once - the worker taking control is no reason to reload", async ({
  page,
}) => {
  let loads = 0;
  page.on("load", () => loads++);
  await open(page);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await page.waitForTimeout(800);
  expect(loads).toBe(1);
});
