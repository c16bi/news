import { defineConfig } from "@playwright/test";

/*
 * The site under test is rendered from tests/fixtures (real feed data,
 * trimmed) by tests/render_site.py - the same build_river.py the hourly
 * workflow runs, no Liveboat, no network.
 *
 * One worker: data.spec.mjs rebuilds the served site mid-test to simulate an
 * hourly rebuild, which would pull the floor out from under anything running
 * alongside it.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: "http://localhost:4173/news/",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    // Most tests are about the page, not the worker; a worker that claims the
    // page mid-test would route pictures past the test's own fakes. The
    // offline and download tests turn it back on.
    serviceWorkers: "block",
    launchOptions: {
      // Lets a machine with a preinstalled Chromium skip `playwright install`.
      executablePath: process.env.PW_CHROMIUM || undefined,
    },
  },
  webServer: {
    command: "python3 ../render_site.py ../fixtures .site && node server.mjs",
    url: "http://localhost:4173/news/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
