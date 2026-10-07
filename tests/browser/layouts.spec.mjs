import { test, expect } from "@playwright/test";
import { open, assertNoErrors } from "./helpers.mjs";

const LAYOUTS = ["compact", "reader", "e1", "e2", "f1", "f2", "f3", "f4"];
const PICTURE_LAYOUTS = new Set(["e1", "e2", "f1", "f2", "f3", "f4"]);
const LEAD_LAYOUTS = new Set(["e2", "f4"]);

for (const width of [390, 1440]) {
  for (const layout of LAYOUTS) {
    test(`${layout} at ${width}px renders the feed cleanly`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, { layout });

      const s = await page.evaluate(() => ({
        layout: document.body.getAttribute("data-lb-layout"),
        rows: document.querySelectorAll("li.feed-item").length,
        groups: document.querySelectorAll(".feed-item-group").length,
        thumbs: document.querySelectorAll("img.lb-thumb").length,
        leads: document.querySelectorAll("li.lb-lead").length,
        groupsWithPictures: [
          ...document.querySelectorAll(".feed-item-group"),
        ].filter((g) =>
          [...g.querySelectorAll("li.feed-item")].some((li) => {
            const item = window.__lb.data.byUrl.get(li.dataset.lbUrl);
            return item && item.image;
          }),
        ).length,
        sideways:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      }));

      expect(s.layout).toBe(layout);
      expect(s.rows).toBeGreaterThan(100);
      expect(s.sideways, "no sideways scroll").toBeLessThanOrEqual(1);

      if (!PICTURE_LAYOUTS.has(layout)) {
        expect(s.thumbs, "text layouts never ask for a picture").toBe(0);
      } else if (LEAD_LAYOUTS.has(layout)) {
        expect(
          s.leads,
          "one picture lead for each day that has a picture",
        ).toBe(s.groupsWithPictures);
        expect(s.thumbs, "and only the leads load a picture").toBe(s.leads);
      } else {
        expect(s.thumbs).toBeGreaterThan(s.rows / 2);
      }
      assertNoErrors(page);
    });
  }
}

for (const [retired, replacement] of [
  ["cards", "f2"],
  ["digest", "e2"],
  ["discover", "f1"],
]) {
  test(`the retired ${retired} layout lands on ${replacement}, which replaced it`, async ({
    page,
  }) => {
    await open(page, { layout: retired });
    await expect(page.locator("body")).toHaveAttribute(
      "data-lb-layout",
      replacement,
    );
    const prefs = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("liveboat-custom:prefs")),
    );
    expect(prefs.layout).toBe(replacement);
  });
}

test("switching layout from settings is remembered", async ({ page }) => {
  await open(page, { layout: "compact" });
  await page.click("#lb-dock");
  await page.click('#lb-layout-tabs button[data-layout="f1"]');
  await expect(page.locator("body")).toHaveAttribute("data-lb-layout", "f1");
  await page.reload();
  await page.waitForFunction(() => window.__lb && window.__lb.ready);
  await expect(page.locator("body")).toHaveAttribute("data-lb-layout", "f1");
});

test("theme applies before the first paint and is remembered", async ({
  page,
}) => {
  await open(page, { theme: "sunset" });
  await expect(page.locator("body")).toHaveClass(/sunset-theme/);
  await page.click("#lb-dock");
  await page.selectOption("#lb-theme-select", "plain");
  await expect(page.locator("body")).toHaveClass(/plain-theme/);
  await expect(page.locator("body")).not.toHaveClass(/sunset-theme/);
  const stored = await page.evaluate(() =>
    localStorage.getItem("liveboat-default-theme"),
  );
  expect(stored).toBe("plain");
});
