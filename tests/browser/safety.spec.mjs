import { test, expect } from "@playwright/test";
import { open } from "./helpers.mjs";

/* Feed content is other people's HTML. These inject hostile stories into the
   newest day file on its way to the page and check none of it does anything. */

const HOSTILE_TITLE = '<img src=x onerror="window.__pwned=1">Hostile headline';
const HOSTILE_TEXT =
  "<script>window.__pwned=1</script>" + "Body text. ".repeat(60);

async function inject(page, stories) {
  await page.route(/\/news\/river\/\d{4}-\d{2}-\d{2}\.json/, async (route) => {
    const response = await route.fetch();
    const day = await response.json();
    if (!route.request().url().includes(stories[0].day))
      return route.fulfill({ response });
    return route.fulfill({
      response,
      json: [...stories.map(({ day, ...s }) => s), ...day],
    });
  });
}

async function newestDay() {
  const fs = await import("node:fs");
  const index = JSON.parse(
    fs.readFileSync(new URL("./.site/river/index.json", import.meta.url)),
  );
  return {
    day: index.days[0].day,
    date: index.built,
    feed: Object.keys(index.feeds)[0],
  };
}

test("markup in a headline or body is shown as text, never run", async ({
  page,
}) => {
  const { day, date, feed } = await newestDay();
  await inject(page, [
    {
      day,
      url: "https://hostile.example/a",
      title: HOSTILE_TITLE,
      date,
      feed,
      text: HOSTILE_TEXT,
    },
  ]);
  await open(page);
  const row = page.locator(
    'li.feed-item[data-lb-url="https://hostile.example/a"]',
  );
  await expect(row.locator(".feed-item-link a")).toHaveText(HOSTILE_TITLE);
  expect(
    await row.locator("img:not(.lb-thumb):not(.lb-source-icon)").count(),
  ).toBe(0);
  await row.locator(".feed-item-link a").click();
  await expect(page.locator("#lb-sheet .lb-sheet-body")).toContainText(
    "<script>",
  );
  expect(await page.locator("#lb-sheet script").count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test("a link that is not http(s) never reaches the page", async ({ page }) => {
  const { day, date, feed } = await newestDay();
  await inject(page, [
    {
      day,
      url: "javascript:window.__pwned=1",
      title: "Script link",
      date,
      feed,
    },
    {
      day,
      url: "data:text/html,<script>1</script>",
      title: "Data link",
      date,
      feed,
    },
  ]);
  await open(page);
  expect(await page.locator("a[href^='javascript:']").count()).toBe(0);
  expect(await page.locator("a[href^='data:']").count()).toBe(0);
  await expect(
    page.locator(".feed-item-link a", { hasText: "Script link" }),
  ).toHaveCount(0);
});

test("a picture that is not https never reaches the page", async ({ page }) => {
  const { day, date, feed } = await newestDay();
  await inject(page, [
    {
      day,
      url: "https://pics.example/a",
      title: "Insecure picture",
      date,
      feed,
      image: "http://pics.example/a.jpg",
    },
    {
      day,
      url: "https://pics.example/b",
      title: "Script picture",
      date,
      feed,
      image: "javascript:alert(1)",
    },
  ]);
  await open(page, { layout: "f1" });
  for (const url of ["https://pics.example/a", "https://pics.example/b"]) {
    await expect(
      page.locator(`li.feed-item[data-lb-url="${url}"] img.lb-thumb`),
    ).toHaveCount(0);
  }
});
