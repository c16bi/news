import { test, expect } from "@playwright/test";
import { open, assertNoErrors } from "./helpers.mjs";

function titles(page) {
  return page.locator("li.feed-item .feed-item-link a").allTextContents();
}

/* Search waits a moment after typing before it filters; wait for it to land. */
async function search(page, query) {
  await page.fill("#filter-search input", query);
  await page.waitForFunction((q) => window.__lb.query === q, query.trim());
}

test("every word must match, case-insensitively", async ({ page }) => {
  await open(page);
  await search(page, "VERSTAPPEN pole");
  await expect.poll(async () => (await titles(page)).length).toBeGreaterThan(0);
  for (const t of await titles(page)) {
    expect(t.toLowerCase()).toContain("verstappen");
    expect(t.toLowerCase()).toContain("pole");
  }
  assertNoErrors(page);
});

test("t: narrows to sources carrying a tag", async ({ page }) => {
  await open(page);
  await search(page, "t:f1");
  await expect.poll(async () => (await titles(page)).length).toBeGreaterThan(0);
  const feeds = await page.evaluate(() =>
    [...document.querySelectorAll("li.feed-item")].map(
      (li) => window.__lb.data.byUrl.get(li.dataset.lbUrl).tags,
    ),
  );
  for (const tags of feeds) expect(tags).toContain("f1");
});

test("several tags mean any of them", async ({ page }) => {
  await open(page);
  await search(page, "t:f1,cycling");
  await expect.poll(async () => (await titles(page)).length).toBeGreaterThan(0);
  const tags = await page.evaluate(() =>
    [...document.querySelectorAll("li.feed-item")].map(
      (li) => window.__lb.data.byUrl.get(li.dataset.lbUrl).tags,
    ),
  );
  expect(tags.some((t) => t.includes("f1"))).toBe(true);
  expect(tags.some((t) => t.includes("cycling"))).toBe(true);
  for (const t of tags)
    expect(t.includes("f1") || t.includes("cycling")).toBe(true);
});

test("no matches says so, and clearing brings the feed back", async ({
  page,
}) => {
  await open(page);
  const all = await page.locator("li.feed-item").count();
  await search(page, "zzqqxx-no-such-story");
  await expect(page.locator("#lb-empty")).toContainText("No stories match");
  await page.click("#lb-empty .lb-empty-action");
  await expect(page.locator("#filter-search input")).toHaveValue("");
  await expect(page.locator("li.feed-item")).toHaveCount(all);
});

test("the help explains search, and works by tap", async ({ page }) => {
  await open(page);
  await expect(page.locator("#filter-search-tip")).toBeHidden();
  await page.click("#filter-search-help");
  await expect(page.locator("#filter-search-tip")).toBeVisible();
  await expect(page.locator("#filter-search-tip")).toContainText("t:sport");
});

test("one source at a time, from settings, cleared from the chip", async ({
  page,
}) => {
  await open(page);
  const all = await page.locator("li.feed-item").count();
  await page.click("#lb-dock");
  const option = await page.locator("#lb-source-select option").nth(1);
  const value = await option.getAttribute("value");
  await page.selectOption("#lb-source-select", value);
  await page.keyboard.press("Escape");
  const feeds = await page.evaluate(() =>
    [...document.querySelectorAll("li.feed-item")].map(
      (li) => window.__lb.data.byUrl.get(li.dataset.lbUrl).feed,
    ),
  );
  expect(new Set(feeds)).toEqual(new Set([value]));
  // In a single-source view the source is named at the top.
  const name = await page.evaluate(
    (v) => window.__lb.data.feeds[v].title,
    value,
  );
  await expect(page.locator(".feed-title")).toBeVisible();
  await expect(page.locator(".feed-title a")).toHaveText(name);
  await expect(page.locator("#lb-filter-chip")).toContainText(name);
  await page.click("#lb-filter-chip");
  await expect(page.locator("li.feed-item")).toHaveCount(all);
  await expect(page.locator(".feed-title")).toBeHidden();
});
