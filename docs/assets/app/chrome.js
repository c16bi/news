/*
 * chrome.js - everything around the feed: search, the settings sheet, the
 * build stamp, toasts, help, the reading progress bar and the small status
 * pieces that say what you are looking at.
 *
 * One rule from the previous version still holds: every setting lives behind
 * one button. Search stays on the page because it is reached for mid-read;
 * the rest is chosen roughly never and should not sit on top of the news.
 */

import { store, LAYOUTS, THEMES, EDITORIAL_LAYOUTS } from "./store.js";
import { el, fullDate, prefersReducedMotion, relativeTime } from "./format.js";

export function createChrome(app) {
  /* ------------------------------------------------------------------ */
  /* theme and layout                                                    */
  /* ------------------------------------------------------------------ */

  function applyTheme() {
    const theme = store.theme();
    for (const [id] of THEMES) document.body.classList.remove(id + "-theme");
    if (theme !== "default") document.body.classList.add(theme + "-theme");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute(
        "content",
        getComputedStyle(document.body)
          .getPropertyValue("--color-background")
          .trim() || meta.getAttribute("content"),
      );
    }
  }

  function applyLayout() {
    const id = store.layout();
    document.body.setAttribute("data-lb-layout", id);
    document.body.classList.toggle("lb-editorial", EDITORIAL_LAYOUTS.has(id));
    document.body.classList.toggle("lb-inapp", store.inApp());
    if (layoutTabs) {
      for (const b of layoutTabs.querySelectorAll("button")) {
        b.setAttribute(
          "aria-selected",
          b.dataset.layout === id ? "true" : "false",
        );
      }
    }
  }

  function setLayout(id) {
    store.setPref("layout", id);
    applyLayout();
    app.render({ keepPlace: true });
  }

  function cycleLayout(delta) {
    const ids = LAYOUTS.map((l) => l.id);
    const i = ids.indexOf(store.layout());
    setLayout(ids[(i + delta + ids.length) % ids.length]);
    toast(LAYOUTS.find((l) => l.id === store.layout()).label + " layout");
  }

  /* ------------------------------------------------------------------ */
  /* search                                                              */
  /* ------------------------------------------------------------------ */

  const search = document.getElementById("filter-search");
  const input = search && search.querySelector("input");
  const clear = search && search.querySelector("#filter-search-clear");
  const helpToggle = search && search.querySelector("#filter-search-help");
  let searchTimer = 0;

  function setQuery(value) {
    app.query = value.trim();
    if (clear) clear.hidden = !value;
    app.render();
  }

  if (input) {
    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      if (clear) clear.hidden = !input.value;
      searchTimer = setTimeout(() => setQuery(input.value), 220);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        clearTimeout(searchTimer);
        setQuery(input.value);
        input.blur();
      }
    });
  }
  if (clear) {
    clear.addEventListener("click", () => {
      input.value = "";
      setQuery("");
      input.focus();
    });
  }
  // Hover-only before, so a phone never saw it. A tap toggles it now.
  if (helpToggle) {
    helpToggle.addEventListener("click", () => {
      const open = helpToggle.getAttribute("aria-expanded") !== "true";
      helpToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  function focusSearch() {
    if (!input) return;
    input.focus();
    input.select();
  }

  /* ------------------------------------------------------------------ */
  /* toasts                                                              */
  /* ------------------------------------------------------------------ */

  let toastEl = null;
  let toastTimer = 0;

  function toast(message, actionLabel, onAction) {
    if (toastEl) toastEl.remove();
    clearTimeout(toastTimer);
    toastEl = el("div");
    toastEl.id = "lb-toast";
    toastEl.setAttribute("role", "status");
    toastEl.appendChild(el("span", null, message));
    if (actionLabel) {
      const button = el("button", null, actionLabel);
      button.type = "button";
      button.addEventListener("click", () => {
        onAction();
        dismiss();
      });
      toastEl.appendChild(button);
    }
    const close = el("button", "lb-toast-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", dismiss);
    toastEl.appendChild(close);
    document.body.appendChild(toastEl);
    // Long enough to reach Undo; not so long it sits over the feed.
    toastTimer = setTimeout(dismiss, actionLabel ? 6000 : 3500);
  }

  function dismiss() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.remove();
    toastEl = null;
  }

  /* ------------------------------------------------------------------ */
  /* settings sheet                                                      */
  /* ------------------------------------------------------------------ */

  let dock = null;
  let newBadge = null;
  let sheet = null;
  let layoutTabs = null;
  const switches = [];

  function section(host, title, slug) {
    host.appendChild(el("h3", "lb-set-heading", title));
    const box = el(
      "div",
      "lb-set-group" + (slug ? " lb-set-group-" + slug : ""),
    );
    host.appendChild(box);
    return box;
  }

  function toggleRow(label, detail, isOn, onToggle) {
    const row = el("button", "lb-set-row");
    row.type = "button";
    row.setAttribute("role", "switch");
    const text = el("span", "lb-set-text");
    text.appendChild(el("span", "lb-set-name", label));
    text.appendChild(el("span", "lb-set-hint", detail));
    const knob = el("span", "lb-set-knob");
    knob.setAttribute("aria-hidden", "true");
    row.appendChild(text);
    row.appendChild(knob);
    const sync = () =>
      row.setAttribute("aria-checked", isOn() ? "true" : "false");
    row.addEventListener("click", () => {
      onToggle();
      syncSettings();
    });
    switches.push(sync);
    sync();
    return row;
  }

  function linkRow(label, href) {
    const a = el("a", "lb-set-row lb-set-row-static");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    const text = el("span", "lb-set-text");
    text.appendChild(el("span", "lb-set-name", label));
    a.appendChild(text);
    return a;
  }

  function syncSettings() {
    switches.forEach((sync) => sync());
    const select = document.getElementById("lb-theme-select");
    if (select) select.value = store.theme();
    const sources = document.getElementById("lb-source-select");
    if (sources) sources.value = store.prefs.source || "";
  }

  function setFilter(key, value) {
    store.setPref(key, value);
    // Saved-only and hide-read answer different questions; one at a time.
    if (key === "savedOnly" && value) store.setPref("hideRead", false);
    if (key === "hideRead" && value) store.setPref("savedOnly", false);
    syncSettings();
    app.render();
  }

  function clearFilters() {
    store.setPref("savedOnly", false);
    store.setPref("hideRead", false);
    store.setPref("source", "");
    if (input && input.value) {
      input.value = "";
      app.query = "";
      if (clear) clear.hidden = true;
    }
    syncSettings();
    app.render();
  }

  function buildSettings() {
    sheet = el("div");
    sheet.id = "lb-settings";
    sheet.hidden = true;
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Settings");
    const panel = el("div", "lb-set-panel");
    sheet.appendChild(panel);
    const grabber = el("div", "lb-set-grabber");
    grabber.setAttribute("aria-hidden", "true");
    panel.appendChild(grabber);

    layoutTabs = el("div");
    layoutTabs.id = "lb-layout-tabs";
    layoutTabs.setAttribute("role", "tablist");
    layoutTabs.setAttribute("aria-label", "Article layout");
    for (const layout of LAYOUTS) {
      const b = el("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.dataset.layout = layout.id;
      b.appendChild(el("span", "lb-layout-name", layout.label));
      b.appendChild(el("span", "lb-layout-hint", layout.hint));
      b.addEventListener("click", () => setLayout(layout.id));
      layoutTabs.appendChild(b);
    }
    section(panel, "Layout").appendChild(layoutTabs);

    const reading = section(panel, "Reading");
    reading.appendChild(
      toggleRow(
        "Saved only",
        "Just the articles you starred",
        () => !!store.prefs.savedOnly,
        () => setFilter("savedOnly", !store.prefs.savedOnly),
      ),
    );
    reading.appendChild(
      toggleRow(
        "Hide read",
        "Drop articles you have already opened",
        () => !!store.prefs.hideRead,
        () => setFilter("hideRead", !store.prefs.hideRead),
      ),
    );
    reading.appendChild(
      toggleRow(
        "Open in app",
        "Read articles here instead of a new tab",
        store.inApp,
        () => {
          store.setPref("inAppReader", !store.inApp());
          applyLayout();
        },
      ),
    );
    reading.appendChild(
      toggleRow(
        "Group the same story",
        "One row when several outlets report it",
        store.grouping,
        () => {
          store.setPref("group", !store.grouping());
          app.render({ keepPlace: true });
        },
      ),
    );

    // Replaces the old feed navigator: the river is one list, and this narrows
    // it to a single publication when that is what you want.
    const sources = section(panel, "Source");
    const sourceRow = el("div", "lb-set-row lb-set-row-static");
    const sourceText = el("span", "lb-set-text");
    sourceText.appendChild(el("span", "lb-set-name", "Show"));
    sourceText.appendChild(
      el("span", "lb-set-hint", "Everything, or one source"),
    );
    const sourceSelect = el("select", "lb-set-select");
    sourceSelect.id = "lb-source-select";
    sourceSelect.setAttribute("aria-label", "Source");
    sourceRow.appendChild(sourceText);
    sourceRow.appendChild(sourceSelect);
    sources.appendChild(sourceRow);
    sourceSelect.addEventListener("change", () => {
      store.setPref("source", sourceSelect.value);
      app.render();
    });

    const look = section(panel, "Appearance");
    const themeRow = el("div", "lb-set-row lb-set-row-static");
    const themeText = el("span", "lb-set-text");
    themeText.appendChild(el("span", "lb-set-name", "Theme"));
    themeText.appendChild(el("span", "lb-set-hint", "Applies to every layout"));
    const themeSelect = el("select", "lb-set-select");
    themeSelect.id = "lb-theme-select";
    themeSelect.setAttribute("aria-label", "Theme");
    for (const [id, label] of THEMES) {
      const opt = el("option", null, label);
      opt.value = id;
      themeSelect.appendChild(opt);
    }
    themeSelect.addEventListener("change", () => {
      store.setTheme(themeSelect.value);
      applyTheme();
    });
    themeRow.appendChild(themeText);
    themeRow.appendChild(themeSelect);
    look.appendChild(themeRow);

    const out = section(panel, "This feed");
    out.appendChild(linkRow("RSS", "rss.xml"));
    out.appendChild(linkRow("OPML", "opml.xml"));
    out.appendChild(
      linkRow("Built with Liveboat", "https://github.com/exaroth/liveboat"),
    );

    const foot = el("div", "lb-set-foot");
    const top = el("button", "lb-set-link", "Back to top");
    top.type = "button";
    top.addEventListener("click", () => {
      toggleSettings(false);
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });
    const helpLink = el("button", "lb-set-link", "Gestures & shortcuts");
    helpLink.type = "button";
    helpLink.addEventListener("click", () => {
      toggleSettings(false);
      toggleHelp();
    });
    foot.appendChild(top);
    foot.appendChild(helpLink);
    panel.appendChild(foot);

    sheet.addEventListener("click", (event) => {
      if (event.target === sheet) toggleSettings(false);
    });
    document.body.appendChild(sheet);
  }

  function fillSources() {
    const select = document.getElementById("lb-source-select");
    if (!select) return;
    const counts = new Map();
    for (const item of app.data.items)
      counts.set(item.feed, (counts.get(item.feed) || 0) + 1);
    select.replaceChildren();
    const all = el(
      "option",
      null,
      "All sources (" + app.data.items.length + ")",
    );
    all.value = "";
    select.appendChild(all);
    Object.entries(app.data.feeds)
      .sort((a, b) => a[1].title.localeCompare(b[1].title))
      .forEach(([id, feed]) => {
        const opt = el(
          "option",
          null,
          feed.title + " (" + (counts.get(id) || 0) + ")",
        );
        opt.value = id;
        select.appendChild(opt);
      });
    select.value =
      store.prefs.source && app.data.feeds[store.prefs.source]
        ? store.prefs.source
        : "";
  }

  function settingsOpen() {
    return !!(sheet && !sheet.hidden);
  }

  function toggleSettings(force) {
    if (!sheet) return;
    const open = typeof force === "boolean" ? force : !settingsOpen();
    sheet.hidden = !open;
    document.body.classList.toggle("lb-settings-open", open);
    dock.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      syncSettings();
      const first = sheet.querySelector("button, select");
      if (first) first.focus();
    } else {
      dock.focus();
    }
  }

  function buildDock() {
    dock = el("button");
    dock.id = "lb-dock";
    dock.type = "button";
    dock.title = "Settings";
    dock.setAttribute("aria-label", "Settings");
    dock.setAttribute("aria-expanded", "false");
    dock.appendChild(el("span", null, "⋯")).setAttribute("aria-hidden", "true");
    dock.addEventListener("click", () => toggleSettings());
    newBadge = el("span");
    newBadge.id = "lb-new-badge";
    newBadge.hidden = true;
    document.body.appendChild(newBadge);
    document.body.appendChild(dock);
  }

  /* ------------------------------------------------------------------ */
  /* help                                                                */
  /* ------------------------------------------------------------------ */

  let help = null;

  function toggleHelp() {
    if (help) {
      help.remove();
      help = null;
      return;
    }
    help = el("div");
    help.id = "lb-help";
    help.setAttribute("role", "dialog");
    help.setAttribute("aria-label", "Gestures and keyboard shortcuts");
    const card = el("div");
    card.id = "lb-help-card";
    const list = (title, rows) => {
      card.appendChild(el("h3", null, title));
      const dl = el("dl");
      for (const [k, v] of rows) {
        dl.appendChild(el("dt", null, k));
        dl.appendChild(el("dd", null, v));
      }
      card.appendChild(dl);
    };
    list("On a touchscreen", [
      ["swipe right", "save / unsave the article"],
      ["swipe left", "mark it read / unread"],
      ["tap", "open it"],
    ]);
    list("Keyboard shortcuts", [
      ["j / k", "next / previous article"],
      ["o · Enter", "open the selected article"],
      ["s", "save / unsave the selected article"],
      ["m", "mark the selected article read / unread"],
      ["u", "hide articles you have read"],
      ["v", "show saved articles only"],
      ["/", "search"],
      ["r", "open articles in-app or in the browser"],
      ["[ / ]", "previous / next layout"],
      [",", "open settings"],
      ["g / G", "jump to top / bottom"],
      ["Esc", "close a panel, clear the selection"],
      ["?", "toggle this panel"],
    ]);
    card.appendChild(
      el(
        "p",
        "lb-help-foot",
        "Read state and saved articles are stored in this browser only.",
      ),
    );
    help.appendChild(card);
    help.addEventListener("click", (event) => {
      if (event.target === help) toggleHelp();
    });
    document.body.appendChild(help);
  }

  /* ------------------------------------------------------------------ */
  /* build stamp                                                         */
  /* ------------------------------------------------------------------ */

  /* Answers "is this current?" - a service worker can serve a perfectly good
     page that is hours old. Tapping it checks for a newer build now. */
  const stamp = document.getElementById("lb-build-stamp");
  const stampText = stamp && stamp.querySelector(".lb-stamp-text");

  function paintStamp() {
    if (!stamp || !app.data.built) return;
    stamp.hidden = false;
    stampText.textContent = "Updated " + relativeTime(app.data.built);
    stamp.title =
      "Built " + fullDate(app.data.built) + " - tap to check for a newer one";
  }

  if (stamp) {
    stamp.addEventListener("click", async () => {
      stampText.textContent = "Checking…";
      const found = await app.checkForUpdate(true);
      stampText.textContent = found ? "Updated just now" : "Up to date";
      setTimeout(paintStamp, 2500);
    });
  }

  /* ------------------------------------------------------------------ */
  /* status: filter chip, empty state, new count                         */
  /* ------------------------------------------------------------------ */

  /* A filter you have forgotten about looks exactly like a feed that has
     stopped working, so whatever is narrowing the list is said right where
     the list starts, and tapping it clears it. */
  function refreshChip() {
    const parts = [];
    if (store.prefs.source && app.data.feeds[store.prefs.source])
      parts.push(app.data.feeds[store.prefs.source].title);
    if (store.prefs.savedOnly) parts.push("Saved only");
    if (store.prefs.hideRead) parts.push("Hiding read");
    let chip = document.getElementById("lb-filter-chip");
    if (!parts.length) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = el("button");
      chip.id = "lb-filter-chip";
      chip.type = "button";
      chip.title = "Clear this filter";
      chip.addEventListener("click", clearFilters);
      const toolbar = document.querySelector("#app .filter-container");
      toolbar.parentNode.insertBefore(chip, toolbar.nextSibling);
    }
    chip.textContent = parts.join(" · ");
    chip.setAttribute("aria-label", parts.join(", ") + " - tap to clear");
  }

  function refreshEmpty() {
    let box = document.getElementById("lb-empty");
    const anyVisible = app.feed.visibleRows().length > 0;
    if (anyVisible || !app.ready) {
      if (box) box.remove();
      return;
    }
    let heading = "Nothing here yet";
    let detail =
      "The feed has not loaded. Check your connection and try again.";
    if (app.query) {
      heading = "No stories match “" + app.query + "”";
      detail =
        "Search looks at headlines and source names. Use t:sport to filter by tag.";
    } else if (store.prefs.savedOnly) {
      heading = "No saved articles yet";
      detail =
        "Tap the ★ on any article, or swipe it right, to save it for later.";
    } else if (store.prefs.hideRead) {
      heading = "You have read everything here";
      detail = "Turn the filter off to see articles you have already opened.";
    } else if (store.prefs.source) {
      heading = "Nothing from this source right now";
      detail = "It may not have published in the last few weeks.";
    }
    if (!box) {
      box = el("div");
      box.id = "lb-empty";
      box.appendChild(el("p", "lb-empty-title"));
      box.appendChild(el("p", "lb-empty-detail"));
      const back = el("button", "lb-empty-action", "Show all articles");
      back.type = "button";
      back.addEventListener("click", clearFilters);
      box.appendChild(back);
      app.feed.root.parentNode.insertBefore(box, app.feed.root);
    }
    box.querySelector(".lb-empty-title").textContent = heading;
    box.querySelector(".lb-empty-detail").textContent = detail;
    box.querySelector(".lb-empty-action").hidden =
      !app.query &&
      !store.prefs.savedOnly &&
      !store.prefs.hideRead &&
      !store.prefs.source;
  }

  function refreshBadge() {
    if (!newBadge) return;
    const count = document.querySelectorAll("#app li.feed-item.lb-new").length;
    newBadge.hidden = !(count > 0 && store.lastVisit);
    newBadge.textContent = count + " new";
    newBadge.title = "Articles published since your last visit";
    const saved = Object.keys(store.saved).length;
    dock.classList.toggle("lb-has-items", saved > 0);
    dock.title = saved ? "Settings — " + saved + " saved" : "Settings";
  }

  function refresh() {
    refreshChip();
    refreshEmpty();
    refreshBadge();
    paintStamp();
    syncSettings();
  }

  /* ------------------------------------------------------------------ */
  /* reading progress, and tucking the chrome away while reading down    */
  /* ------------------------------------------------------------------ */

  function buildProgress() {
    const bar = el("div");
    bar.id = "lb-progress";
    document.body.appendChild(bar);
    let ticking = false;
    let lastY = window.scrollY;
    const update = () => {
      ticking = false;
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (max > 0 ? (y / max) * 100 : 0).toFixed(2) + "%";
      document.body.classList.toggle("lb-scrolled", y > 240);
      // 6px of hysteresis ignores scroll jitter.
      if (Math.abs(y - lastY) > 6) {
        document.body.classList.toggle(
          "lb-chrome-hidden",
          y > lastY && y > 160,
        );
        lastY = y;
      }
    };
    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      },
      { passive: true },
    );
    update();
  }

  function build() {
    applyTheme();
    applyLayout();
    buildProgress();
    buildDock();
    buildSettings();
    syncSettings();
  }

  return {
    build,
    refresh,
    fillSources,
    toast,
    toggleHelp,
    toggleSettings,
    settingsOpen,
    helpOpen: () => !!help,
    focusSearch,
    cycleLayout,
    setFilter,
    applyLayout,
  };
}
