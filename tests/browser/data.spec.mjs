import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  open,
  assertNoErrors,
  rebuild,
  restoreSite,
  addStory,
  FIXTURES,
  SITE,
} from "./helpers.mjs";

/* These rebuild the site the server is serving, as the hourly workflow does,
   so they run one at a time and put the fixture back afterwards. */
test.describe.configure({ mode: "serial" });
test.afterEach(() => restoreSite());

const HITS = "http://localhost:4173/__hits";

function aSourceFeed() {
  for (const name of readdirSync(join(FIXTURES, "feeds")).sort()) {
    if (name.endsWith("_archive.json") || name === "icons.json") continue;
    const feed = JSON.parse(
      readFileSync(join(FIXTURES, "feeds", name), "utf8"),
    );
    if (!feed.isQuery) return name;
  }
  throw new Error("no source feed in the fixture");
}

function utcDay(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

test.describe("with the service worker", () => {
  test.use({ serviceWorkers: "allow" });

  test("a visit after a rebuild downloads only the day that changed", async ({
    page,
    request,
  }) => {
    await open(page);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    // Once more, so every day file has come through the worker and is cached.
    await page.reload();
    await page.waitForFunction(() => window.__lb && window.__lb.ready);

    const days = JSON.parse(
      readFileSync(join(SITE, "river", "index.json"), "utf8"),
    ).days.length;
    await request.get(HITS + "/reset");
    const url = "https://www.example.com/a-story-from-the-next-build";
    const built = rebuild((data, built) =>
      addStory(data, {
        feedFile: aSourceFeed(),
        url,
        title: "A story from the next build",
        date: built - 60,
      }),
    );

    await page.reload();
    await page.waitForFunction(() => window.__lb && window.__lb.ready);
    await expect(
      page.locator(`li.feed-item[data-lb-url="${url}"]`),
    ).toHaveCount(1);

    const hits = await (await request.get(HITS)).json();
    const dayFiles = Object.keys(hits).filter((p) =>
      /\/river\/\d{4}-\d{2}-\d{2}\.json$/.test(p),
    );
    expect(
      dayFiles,
      `${days} days in the feed; only the changed one should be fetched`,
    ).toEqual([`/news/river/${utcDay(built - 60)}.json`]);
    expect(hits["/news/river/index.json"]).toBeGreaterThanOrEqual(1);
    expect(
      hits["/news/river/clusters.json"],
      "story groups unchanged, so not refetched",
    ).toBeUndefined();
  });
});

test("an open page picks up a new build in place, and keeps your place", async ({
  page,
}) => {
  await open(page);
  const anchor = page.locator("li.feed-item").nth(25);
  await anchor.scrollIntoViewIfNeeded();
  const anchorUrl = await anchor.getAttribute("data-lb-url");
  const before = (await anchor.boundingBox()).y;

  const url = "https://www.example.com/arrived-while-reading";
  rebuild((data, built) =>
    addStory(data, {
      feedFile: aSourceFeed(),
      url,
      title: "Arrived while you were reading",
      date: built - 60,
    }),
  );
  expect(await page.evaluate(() => window.__lb.checkForUpdate(true))).toBe(
    true,
  );

  await expect(page.locator(`li.feed-item[data-lb-url="${url}"]`)).toHaveCount(
    1,
  );
  await expect(page.locator("#lb-toast")).toContainText("1 new story");
  const after = (
    await page.locator(`li.feed-item[data-lb-url="${anchorUrl}"]`).boundingBox()
  ).y;
  expect(
    Math.abs(after - before),
    "the story you were looking at stays put",
  ).toBeLessThan(4);
  assertNoErrors(page);
});

test("no new build means nothing changes", async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => window.__lb.checkForUpdate(true))).toBe(
    false,
  );
  await expect(page.locator("#lb-toast")).toHaveCount(0);
});

test("without the river the page falls back to Liveboat's own feed files", async ({
  page,
}) => {
  rmSync(join(SITE, "river"), { recursive: true, force: true });
  await open(page);
  expect(await page.evaluate(() => window.__lb.data.fromRiver)).toBe(false);
  expect(await page.locator("li.feed-item").count()).toBeGreaterThan(100);
  // The topic feeds repeat the source feeds' stories; still one row each.
  const urls = await page
    .locator("li.feed-item")
    .evaluateAll((rows) => rows.map((r) => r.dataset.lbUrl));
  expect(new Set(urls).size).toBe(urls.length);
  assertNoErrors(page);
});
