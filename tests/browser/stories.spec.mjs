import { test, expect } from "@playwright/test";
import { open, assertNoErrors } from "./helpers.mjs";

/* The fixture is real feed data and keeps every story group the live feed
   produced, e.g. Autosport and The Race both reporting Russell's grid penalty. */

async function firstGroup(page) {
  return page.evaluate(() => {
    const also = document.querySelector("li.lb-also");
    const lead = also.previousElementSibling;
    const members = [...also.querySelectorAll(".lb-also-item")].map(
      (li) => li.dataset.lbUrl,
    );
    return { lead: lead.dataset.lbUrl, members };
  });
}

test("one story from several outlets is one row, with the others behind it", async ({
  page,
}) => {
  await open(page);
  const { lead, members } = await firstGroup(page);
  expect(members.length).toBeGreaterThan(0);
  // The other outlets' versions are not rows of their own.
  for (const url of members) {
    await expect(
      page.locator(`li.feed-item[data-lb-url="${url}"]`),
    ).toHaveCount(0);
  }
  const also = page.locator("li.lb-also").first();
  await expect(also.locator(".lb-also-list")).toBeHidden();
  await also.locator(".lb-also-toggle").click();
  await expect(also.locator(".lb-also-list")).toBeVisible();
  await expect(also.locator(".lb-also-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(lead).toBeTruthy();
  assertNoErrors(page);
});

test("another outlet's version opens in the reader and is marked read", async ({
  page,
}) => {
  await open(page);
  const { members } = await firstGroup(page);
  const also = page.locator("li.lb-also").first();
  await also.locator(".lb-also-toggle").click();
  await also.locator(`.lb-also-item[data-lb-url="${members[0]}"] a`).click();
  const title = await page.evaluate(
    (u) => window.__lb.data.byUrl.get(u).title,
    members[0],
  );
  await expect(page.locator("#lb-sheet .lb-sheet-title")).toHaveText(title);
  await page.keyboard.press("Escape");
  await expect(
    also.locator(`.lb-also-item[data-lb-url="${members[0]}"]`),
  ).toHaveClass(/lb-read/);
});

test("grouping can be turned off, and every version gets its own row", async ({
  page,
}) => {
  await open(page);
  const { members } = await firstGroup(page);
  const before = await page.locator("li.feed-item").count();
  await page.click("#lb-dock");
  await page.click("button[role=switch]:has-text('Group the same story')");
  await page.keyboard.press("Escape");
  await expect(page.locator("li.lb-also")).toHaveCount(0);
  await expect(
    page.locator(`li.feed-item[data-lb-url="${members[0]}"]`),
  ).toHaveCount(1);
  expect(await page.locator("li.feed-item").count()).toBeGreaterThan(before);
  const prefs = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("liveboat-custom:prefs")),
  );
  expect(prefs.group).toBe(false);
});

test("search never hides a match inside a group", async ({ page }) => {
  await open(page);
  const { members } = await firstGroup(page);
  const title = await page.evaluate(
    (u) => window.__lb.data.byUrl.get(u).title,
    members[0],
  );
  // A distinctive word from the version that is normally tucked away.
  const word = title
    .split(/\s+/)
    .sort((a, b) => b.length - a.length)[0]
    .replace(/[^\w]/g, "");
  await page.fill("#filter-search input", word);
  await expect(
    page.locator(`li.feed-item[data-lb-url="${members[0]}"]`),
  ).toHaveCount(1);
  await expect(page.locator("li.lb-also")).toHaveCount(0);
});

test("under hide read, a story you have read goes with all its versions", async ({
  page,
}) => {
  await open(page);
  const { lead } = await firstGroup(page);
  await page.evaluate((u) => {
    localStorage.setItem(
      "liveboat-custom:read",
      JSON.stringify({ [u]: Math.floor(Date.now() / 1000) }),
    );
    const p = JSON.parse(localStorage.getItem("liveboat-custom:prefs"));
    p.hideRead = true;
    localStorage.setItem("liveboat-custom:prefs", JSON.stringify(p));
  }, lead);
  await page.reload();
  await page.waitForFunction(() => window.__lb && window.__lb.ready);
  await expect(
    page.locator(`li.feed-item[data-lb-url="${lead}"]`),
  ).toBeHidden();
  await expect(page.locator(`li.lb-also[data-lead="${lead}"]`)).toBeHidden();
});
