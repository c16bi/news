/*
 * main.js - boot the reader.
 *
 * This replaces both the prebuilt Vue app Liveboat ships and the 2,300-line
 * layer that used to be patched over the top of it. Everything here renders
 * from data the build prepares (docs/river/), so features are written against
 * this code rather than worked around someone else's.
 */

import { store } from "./store.js";
import { fetchIndex, loadFeed, loadIcons } from "./data.js";
import { setBuildIcons } from "./logos.js";
import { createFeed } from "./feed.js";
import { createGestures } from "./gestures.js";
import { createSheet } from "./sheet.js";
import { createChrome } from "./chrome.js";
import { bindKeys } from "./keys.js";
import { registerWorker, trackConnectivity, updateWorker } from "./offline.js";
import { domainOf } from "./format.js";

// How often an open page asks whether a newer build exists. The build runs
// hourly; this only decides how soon after it the page notices.
const POLL_MS = 2 * 60 * 1000;

const app = {
  ready: false,
  query: "",
  stats: null,
  data: {
    items: [],
    byUrl: new Map(),
    clusterOf: new Map(),
    feeds: {},
    built: 0,
  },
};

function adopt(result) {
  const byUrl = new Map(result.items.map((i) => [i.url, i]));
  const clusterOf = new Map();
  for (const group of result.clusters || []) {
    if (!Array.isArray(group)) continue;
    const members = group.filter((u) => byUrl.has(u));
    if (members.length < 2) continue;
    for (const url of members) clusterOf.set(url, members);
  }
  app.data = { ...result, byUrl, clusterOf };
}

/* --- actions shared by rows, gestures, the sheet and the keyboard --- */

app.markOpened = (url) => {
  store.setRead(url, true);
  app.feed.syncRows(url);
  app.refreshChrome();
};

app.open = (item, event) => {
  // Modified clicks always belong to the browser.
  if (
    event &&
    (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
  ) {
    app.markOpened(item.url);
    return;
  }
  if (store.inApp()) {
    if (event) event.preventDefault();
    app.sheet.open(item);
    return;
  }
  app.markOpened(item.url);
  if (!event) window.open(item.url, "_blank", "noopener");
};

app.toggleSaved = (item, li, announce) => {
  const wasSaved = store.isSaved(item.url);
  store.toggleSaved(item.url, {
    title: item.title,
    domain: item.domain || domainOf(item.url),
    date: item.date,
  });
  // In the saved-only view an unsaved row would vanish mid-tap, which reads as
  // "nothing happened". It stays until the view is next drawn.
  if (li && wasSaved && store.prefs.savedOnly)
    li.classList.add("lb-just-unsaved");
  app.feed.syncRows(item.url);
  app.refreshChrome();
  if (announce) {
    app.chrome.toast(wasSaved ? "Removed from saved" : "Saved", "Undo", () => {
      store.toggleSaved(item.url, {
        title: item.title,
        domain: item.domain,
        date: item.date,
      });
      if (li) li.classList.remove("lb-just-unsaved");
      app.feed.syncRows(item.url);
      app.refreshChrome();
    });
  }
};

app.toggleRead = (item, li) => {
  const wasRead = store.isRead(item.url);
  store.setRead(item.url, !wasRead);
  // Marking read under hide-read takes the row out from under the thumb;
  // keep it on screen and say what happened.
  if (li && !wasRead && store.prefs.hideRead)
    li.classList.add("lb-just-unsaved");
  app.feed.syncRows(item.url);
  app.refreshChrome();
  app.chrome.toast(wasRead ? "Marked unread" : "Marked read", "Undo", () => {
    store.setRead(item.url, wasRead);
    if (li) li.classList.remove("lb-just-unsaved");
    app.feed.syncRows(item.url);
    app.refreshChrome();
  });
};

app.render = (options) => {
  app.feed.render(options);
};

app.refreshChrome = () => {
  if (app.chrome) app.chrome.refresh();
};

/* --- live refresh --- */

let checking = false;

app.checkForUpdate = async (force) => {
  if (checking) return false;
  if (!force && (document.hidden || !navigator.onLine)) return false;
  checking = true;
  try {
    if (force) updateWorker();
    const index = await fetchIndex();
    if (!index || !(index.built > app.data.built)) return false;
    const before = new Set(app.data.items.map((i) => i.url));
    adopt(await loadFeed(index));
    app.chrome.fillSources();
    app.render({ keepPlace: true });
    const fresh = app.data.items.filter((i) => !before.has(i.url)).length;
    if (fresh) {
      app.chrome.toast(
        fresh === 1 ? "1 new story" : fresh + " new stories",
        "Show",
        () => window.scrollTo({ top: 0 }),
      );
    }
    return true;
  } catch (e) {
    return false;
  } finally {
    checking = false;
  }
};

/* --- boot --- */

async function boot() {
  app.chrome = createChrome(app);
  app.feed = createFeed(app);
  app.sheet = createSheet(app);
  app.bindGestures = createGestures(app);

  const main = document.querySelector("#app main");
  const spinner = main.querySelector(".loading-spinner");
  main.appendChild(app.feed.root);
  app.chrome.build();
  trackConnectivity();
  registerWorker(app.chrome.toast);
  bindKeys(app);

  try {
    adopt(await loadFeed());
  } catch (e) {
    /* rendered as the empty state below */
  }
  app.ready = true;
  if (spinner) spinner.remove();
  app.chrome.fillSources();
  app.render();

  loadIcons(app.data.iconsVersion).then(setBuildIcons);

  setInterval(() => {
    app.feed.refreshTimes();
    app.refreshChrome();
  }, 60 * 1000);
  setInterval(() => app.checkForUpdate(false), POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) app.checkForUpdate(false);
  });

  // For the test suite and for poking at it from the console.
  window.__lb = app;
}

boot();
