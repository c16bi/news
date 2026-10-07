import { test, expect } from "@playwright/test";
import { open, assertNoErrors, swipe, stored } from "./helpers.mjs";

const firstRow = "li.feed-item:not(.lb-just-unsaved)";

test.describe("the in-app reader", () => {
  test("opens on a headline tap with the article body as paragraphs", async ({
    page,
  }) => {
    await open(page);
    // A story whose text is long enough to be the article, not a summary.
    const url = await page.evaluate(
      () => window.__lb.data.items.find((i) => i.text.length > 800).url,
    );
    await page.evaluate((u) => {
      const li = document.querySelector(
        `li.feed-item[data-lb-url="${CSS.escape(u)}"]`,
      );
      li.scrollIntoView();
    }, url);
    await page.click(`li.feed-item[data-lb-url="${url}"] .feed-item-link a`);
    const body = page.locator("#lb-sheet .lb-sheet-body");
    await expect(body).toHaveClass(/lb-sheet-full/);
    expect(await body.locator("p").count()).toBeGreaterThan(1);
    // Opening it marks it read.
    expect((await stored(page, "read"))[url]).toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(page.locator("#lb-sheet")).toHaveCount(0);
    assertNoErrors(page);
  });

  test("shows the feed's summary when that is all there is", async ({
    page,
  }) => {
    await open(page);
    const url = await page.evaluate(
      () =>
        window.__lb.data.items.find(
          (i) => i.text && i.text.length < 300 && i.text.length > 20,
        ).url,
    );
    await page.evaluate(
      (u) => window.__lb.open(window.__lb.data.byUrl.get(u), null),
      url,
    );
    const body = page.locator("#lb-sheet .lb-sheet-body");
    await expect(body).not.toHaveClass(/lb-sheet-full/);
    await expect(body).not.toHaveText("No preview available for this article.");
  });

  test("with in-app reading off, a headline is an ordinary link to the source", async ({
    page,
  }) => {
    await open(page, { prefs: { inAppReader: false } });
    const a = page.locator(`${firstRow} .feed-item-link a`).first();
    await expect(a).toHaveAttribute("target", "_blank");
    await expect(a).toHaveAttribute("rel", /noopener/);
    const [popup] = await Promise.all([page.waitForEvent("popup"), a.click()]);
    await popup.close();
    await expect(page.locator("#lb-sheet")).toHaveCount(0);
  });
});

test.describe("saving and reading state", () => {
  test("the star saves and unsaves", async ({ page }) => {
    await open(page);
    const row = page.locator(firstRow).first();
    const url = await row.getAttribute("data-lb-url");
    await row.locator(".lb-star").click();
    await expect(row).toHaveClass(/lb-saved/);
    expect((await stored(page, "saved"))[url].title).toBeTruthy();
    await row.locator(".lb-star").click();
    await expect(row).not.toHaveClass(/lb-saved/);
  });

  test("swipe right saves, with undo", async ({ page }) => {
    await open(page);
    const url = await page
      .locator(firstRow)
      .first()
      .getAttribute("data-lb-url");
    await swipe(page, firstRow, 180);
    await expect(page.locator("#lb-toast")).toContainText("Saved");
    expect((await stored(page, "saved"))[url]).toBeTruthy();
    await page.click("#lb-toast button:has-text('Undo')");
    expect((await stored(page, "saved"))[url]).toBeFalsy();
  });

  test("swipe left marks read, with undo", async ({ page }) => {
    await open(page);
    const url = await page
      .locator(firstRow)
      .first()
      .getAttribute("data-lb-url");
    await swipe(page, firstRow, -180);
    await expect(page.locator("#lb-toast")).toContainText("Marked read");
    expect((await stored(page, "read"))[url]).toBeTruthy();
    await page.click("#lb-toast button:has-text('Undo')");
    expect((await stored(page, "read"))[url]).toBeFalsy();
  });

  test("a short drag does nothing", async ({ page }) => {
    await open(page);
    await swipe(page, firstRow, 30);
    await expect(page.locator("#lb-toast")).toHaveCount(0);
  });

  test("hide read drops what you have opened, and says so", async ({
    page,
  }) => {
    await open(page);
    const urls = await page
      .locator("li.feed-item")
      .evaluateAll((rows) => rows.slice(0, 3).map((r) => r.dataset.lbUrl));
    const read = Object.fromEntries(
      urls.map((u) => [u, Math.floor(Date.now() / 1000)]),
    );
    await page.evaluate(
      (read) =>
        localStorage.setItem("liveboat-custom:read", JSON.stringify(read)),
      read,
    );
    await page.reload();
    await page.waitForFunction(() => window.__lb && window.__lb.ready);
    await page.click("#lb-dock");
    await page.click("button[role=switch]:has-text('Hide read')");
    await page.keyboard.press("Escape");
    for (const u of urls)
      await expect(
        page.locator(`li.feed-item[data-lb-url="${u}"]`),
      ).toBeHidden();
    await expect(page.locator("#lb-filter-chip")).toContainText("Hiding read");
    await page.click("#lb-filter-chip");
    await expect(
      page.locator(`li.feed-item[data-lb-url="${urls[0]}"]`),
    ).toBeVisible();
  });

  test("saved only lists everything saved, including stories that have left the feed", async ({
    page,
  }) => {
    const gone = "https://www.example.com/aged-out-of-the-feed";
    await open(page, {
      saved: {
        [gone]: {
          t: 1700000000,
          title: "An article saved weeks ago",
          domain: "example.com",
          date: 1699990000,
        },
      },
    });
    await page.click("#lb-dock");
    await page.click("button[role=switch]:has-text('Saved only')");
    await page.keyboard.press("Escape");
    await expect(page.locator("li.feed-item")).toHaveCount(1);
    await expect(page.locator("li.feed-item .feed-item-link a")).toHaveText(
      "An article saved weeks ago",
    );
    await expect(page.locator("#lb-filter-chip")).toContainText("Saved only");
  });

  test("saved only with nothing saved explains how to save", async ({
    page,
  }) => {
    await open(page, { prefs: { savedOnly: true } });
    await expect(page.locator("#lb-empty")).toContainText(
      "No saved articles yet",
    );
  });
});

test.describe("keyboard", () => {
  test("j/k move, s saves, m marks read, ? and Esc", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    const cursor = page.locator("li.feed-item.lb-cursor");
    await expect(cursor).toHaveCount(1);
    const url = await cursor.getAttribute("data-lb-url");
    const second = await page
      .locator("li.feed-item")
      .nth(1)
      .getAttribute("data-lb-url");
    expect(url).toBe(second);
    await page.keyboard.press("s");
    expect((await stored(page, "saved"))[url]).toBeTruthy();
    await page.keyboard.press("m");
    expect((await stored(page, "read"))[url]).toBeTruthy();
    await page.keyboard.press("?");
    await expect(page.locator("#lb-help")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#lb-help")).toHaveCount(0);
    await page.keyboard.press("/");
    await expect(page.locator("#filter-search input")).toBeFocused();
  });
});
