/*
 * custom.js — progressive enhancement layer for the Liveboat default template.
 *
 * The Liveboat SPA (index.js) is a prebuilt bundle we do not modify. This file
 * loads *before* it, wraps `fetch` to observe the feed JSON the app downloads,
 * and then decorates the rendered DOM from the outside. Every selector lookup
 * is guarded: if the upstream bundle changes its markup, features degrade to
 * nothing rather than throwing.
 *
 * Features
 *   - Relative timestamps + full date tooltips on every article
 *   - Read tracking (click an article -> it dims), with a "hide read" filter
 *   - Save for later (star), with a "saved only" filter
 *   - "New since your last visit" markers and count
 *   - Source chips (monogram + clean domain, no external requests)
 *   - Keyboard navigation: j/k/o/s/m/u//?/g/G/Esc
 *   - Reading progress bar, back to top, floating control dock
 *
 * All state lives in localStorage under the `liveboat-custom:` prefix and is
 * pruned so it cannot grow without bound.
 */
(function () {
  "use strict";

  var NS = "liveboat-custom:";
  var READ_RETENTION_DAYS = 60;
  var MAX_SAVED = 500;

  /* ------------------------------------------------------------------ */
  /* storage                                                             */
  /* ------------------------------------------------------------------ */

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(NS + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
    } catch (e) {
      /* quota or private mode - state is best effort */
    }
  }

  var now = Date.now();

  // url -> unix seconds when it was marked read
  var readMap = load("read", {});
  var cutoff = now / 1000 - READ_RETENTION_DAYS * 86400;
  var pruned = false;
  for (var u in readMap) {
    if (!(readMap[u] > cutoff)) {
      delete readMap[u];
      pruned = true;
    }
  }
  if (pruned) save("read", readMap);

  // url -> {t: saved-at, title, domain}
  var savedMap = load("saved", {});

  var prefs = load("prefs", {});
  var lastVisit = load("lastVisit", 0);
  save("lastVisit", Math.floor(now / 1000));

  /* ------------------------------------------------------------------ */
  /* feed metadata harvesting                                            */
  /* ------------------------------------------------------------------ */

  // url -> {date: unix seconds, len: content length, feed: display title}
  var meta = Object.create(null);
  var metaDirty = false;

  function harvest(payload) {
    if (!payload || !payload.items || !payload.items.length) return;
    var feedName = payload.displayTitle || payload.title || "";
    for (var i = 0; i < payload.items.length; i++) {
      var it = payload.items[i];
      if (!it || !it.url || meta[it.url]) continue;
      meta[it.url] = { date: it.date || 0, feed: feedName };
      metaDirty = true;
    }
    if (metaDirty) schedule();
  }

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function (input, init) {
      var promise = nativeFetch.apply(this, arguments);
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (/\/feeds\/[^/?]+\.json/.test(url)) {
        promise
          .then(function (response) {
            if (!response || !response.ok) return;
            return response
              .clone()
              .json()
              .then(harvest)
              .catch(function () {});
          })
          .catch(function () {});
      }
      return promise;
    };
  }

  /* ------------------------------------------------------------------ */
  /* formatting helpers                                                  */
  /* ------------------------------------------------------------------ */

  var MINUTE = 60,
    HOUR = 3600,
    DAY = 86400;

  function relativeTime(unixSeconds) {
    var delta = Math.floor(now / 1000) - unixSeconds;
    if (delta < 0) delta = 0;
    if (delta < MINUTE) return "now";
    if (delta < HOUR) return Math.floor(delta / MINUTE) + "m";
    if (delta < DAY) return Math.floor(delta / HOUR) + "h";
    if (delta < 7 * DAY) return Math.floor(delta / DAY) + "d";
    if (delta < 365 * DAY) return Math.floor(delta / (7 * DAY)) + "w";
    return Math.floor(delta / (365 * DAY)) + "y";
  }

  function fullDate(unixSeconds) {
    try {
      return new Date(unixSeconds * 1000).toLocaleString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (e) {
      return new Date(unixSeconds * 1000).toString();
    }
  }

  function cleanDomain(raw) {
    return String(raw || "")
      .replace(/^\(|\)$/g, "")
      .replace(/^www\d?\./, "")
      .trim();
  }

  // Deterministic hue so each source keeps a stable colour across reloads.
  function hueFor(text) {
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) % 360;
  }

  function monogram(domain) {
    var base = domain.split(".")[0] || domain;
    return base.slice(0, 2).toUpperCase();
  }

  /* ------------------------------------------------------------------ */
  /* per-item decoration                                                 */
  /* ------------------------------------------------------------------ */

  function markRead(url, isRead) {
    if (isRead) readMap[url] = Math.floor(Date.now() / 1000);
    else delete readMap[url];
    save("read", readMap);
  }

  function toggleSaved(url, title, domain) {
    if (savedMap[url]) {
      delete savedMap[url];
    } else {
      var keys = Object.keys(savedMap);
      if (keys.length >= MAX_SAVED) {
        keys
          .sort(function (a, b) {
            return (savedMap[a].t || 0) - (savedMap[b].t || 0);
          })
          .slice(0, keys.length - MAX_SAVED + 1)
          .forEach(function (k) {
            delete savedMap[k];
          });
      }
      savedMap[url] = {
        t: Math.floor(Date.now() / 1000),
        title: title,
        domain: domain,
      };
    }
    save("saved", savedMap);
  }

  function decorateItem(li) {
    var linkWrap = li.querySelector(".feed-item-link");
    var anchor = linkWrap && linkWrap.querySelector("a[href]");
    if (!anchor) return;

    var url = anchor.href;
    li.setAttribute("data-lb-url", url);

    // --- source chip: "(www.bloomberg.com)" -> a compact labelled chip ---
    var domainEl = li.querySelector(".feed-item-domain");
    if (domainEl && !domainEl.hasAttribute("data-lb-chip")) {
      var domain = cleanDomain(domainEl.textContent);
      domainEl.setAttribute("data-lb-chip", "");
      domainEl.textContent = "";
      domainEl.title = domain;

      var badge = document.createElement("span");
      badge.className = "lb-source-badge";
      badge.textContent = monogram(domain);
      badge.style.setProperty("--lb-hue", hueFor(domain));

      var label = document.createElement("span");
      label.className = "lb-source-label";
      label.textContent = domain;

      domainEl.appendChild(badge);
      domainEl.appendChild(label);
    }

    // --- timestamp + reading time ---
    var info = meta[url];
    var timeEl = li.querySelector(".lb-time");
    if (info && info.date) {
      if (!timeEl) {
        timeEl = document.createElement("time");
        timeEl.className = "lb-time";
        li.insertBefore(timeEl, li.firstChild);
      }
      timeEl.textContent = relativeTime(info.date);
      timeEl.dateTime = new Date(info.date * 1000).toISOString();
      timeEl.title = fullDate(info.date);

      if (lastVisit && info.date > lastVisit && !readMap[url]) {
        li.classList.add("lb-new");
      } else {
        li.classList.remove("lb-new");
      }
    } else if (!timeEl) {
      // Placeholder keeps the time column aligned while metadata loads.
      timeEl = document.createElement("time");
      timeEl.className = "lb-time lb-time-pending";
      li.insertBefore(timeEl, li.firstChild);
    }

    // --- save-for-later button ---
    if (!li.querySelector(".lb-star")) {
      var star = document.createElement("button");
      star.type = "button";
      star.className = "lb-star";
      star.setAttribute("aria-pressed", savedMap[url] ? "true" : "false");
      star.title = "Save for later (s)";
      star.setAttribute("aria-label", "Save for later");
      star.textContent = "★";
      star.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        var titleText = anchor.textContent.trim();
        var dom = cleanDomain(
          (li.querySelector(".lb-source-label") || {}).textContent,
        );
        toggleSaved(url, titleText, dom);
        applyState(li);
        refreshDock();
      });
      li.appendChild(star);
    }

    if (!li.hasAttribute("data-lb-bound")) {
      li.setAttribute("data-lb-bound", "");
      anchor.addEventListener("click", function () {
        markRead(url, true);
        applyState(li);
        refreshDock();
      });
      // Middle click / cmd-click open in a background tab without firing click.
      anchor.addEventListener("auxclick", function (event) {
        if (event.button !== 1) return;
        markRead(url, true);
        applyState(li);
        refreshDock();
      });
    }

    applyState(li);
  }

  function applyState(li) {
    var url = li.getAttribute("data-lb-url");
    if (!url) return;
    li.classList.toggle("lb-read", !!readMap[url]);
    li.classList.toggle("lb-saved", !!savedMap[url]);
    if (readMap[url]) li.classList.remove("lb-new");
    var star = li.querySelector(".lb-star");
    if (star)
      star.setAttribute("aria-pressed", savedMap[url] ? "true" : "false");
  }

  /* ------------------------------------------------------------------ */
  /* scheduling: re-decorate whenever the SPA re-renders                 */
  /* ------------------------------------------------------------------ */

  var frame = null;

  function decorateAll() {
    frame = null;
    metaDirty = false;
    var items = document.querySelectorAll(".feed-item");
    for (var i = 0; i < items.length; i++) {
      try {
        decorateItem(items[i]);
      } catch (e) {
        /* one bad row must not stop the rest */
      }
    }
    refreshDock();
  }

  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(decorateAll);
  }

  /* ------------------------------------------------------------------ */
  /* floating dock                                                       */
  /* ------------------------------------------------------------------ */

  var dock, hideReadBtn, savedBtn, newBadge, topBtn;

  function setPref(key, value) {
    prefs[key] = value;
    save("prefs", prefs);
  }

  function applyFilters() {
    document.body.classList.toggle("lb-hide-read", !!prefs.hideRead);
    document.body.classList.toggle("lb-saved-only", !!prefs.savedOnly);
    document.body.classList.toggle("lb-scrolled", window.scrollY > 240);
    if (hideReadBtn)
      hideReadBtn.setAttribute(
        "aria-pressed",
        prefs.hideRead ? "true" : "false",
      );
    if (savedBtn)
      savedBtn.setAttribute("aria-pressed", prefs.savedOnly ? "true" : "false");
  }

  function makeDockButton(label, title, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "lb-dock-btn";
    b.innerHTML = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", onClick);
    return b;
  }

  function buildDock() {
    dock = document.createElement("div");
    dock.id = "lb-dock";

    savedBtn = makeDockButton("★", "Show saved articles only (v)", function () {
      setPref("savedOnly", !prefs.savedOnly);
      if (prefs.savedOnly) setPref("hideRead", false);
      applyFilters();
    });

    hideReadBtn = makeDockButton(
      "◎",
      "Hide articles you have read (u)",
      function () {
        setPref("hideRead", !prefs.hideRead);
        if (prefs.hideRead) setPref("savedOnly", false);
        applyFilters();
      },
    );

    topBtn = makeDockButton("↑", "Back to top (g)", function () {
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });

    var helpBtn = makeDockButton("?", "Keyboard shortcuts (?)", toggleHelp);

    newBadge = document.createElement("span");
    newBadge.id = "lb-new-badge";
    newBadge.hidden = true;

    dock.appendChild(newBadge);
    dock.appendChild(savedBtn);
    dock.appendChild(hideReadBtn);
    dock.appendChild(topBtn);
    dock.appendChild(helpBtn);
    document.body.appendChild(dock);
    applyFilters();
  }

  function refreshDock() {
    if (!newBadge) return;
    var count = document.querySelectorAll(".feed-item.lb-new").length;
    if (count > 0 && lastVisit) {
      newBadge.hidden = false;
      newBadge.textContent = count + " new";
      newBadge.title = "Articles published since your last visit";
    } else {
      newBadge.hidden = true;
    }
    var saved = Object.keys(savedMap).length;
    if (savedBtn) {
      savedBtn.classList.toggle("lb-has-items", saved > 0);
      savedBtn.title = saved
        ? "Show saved articles only (v) — " + saved + " saved"
        : "Show saved articles only (v)";
    }
  }

  /* ------------------------------------------------------------------ */
  /* reading progress                                                    */
  /* ------------------------------------------------------------------ */

  function buildProgressBar() {
    var bar = document.createElement("div");
    bar.id = "lb-progress";
    document.body.appendChild(bar);
    var ticking = false;
    function update() {
      ticking = false;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var pct = max > 0 ? (window.scrollY / max) * 100 : 0;
      bar.style.width = pct.toFixed(2) + "%";
      document.body.classList.toggle("lb-scrolled", window.scrollY > 240);
    }
    window.addEventListener(
      "scroll",
      function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      },
      { passive: true },
    );
    update();
  }

  /* ------------------------------------------------------------------ */
  /* keyboard navigation                                                 */
  /* ------------------------------------------------------------------ */

  var cursor = -1;

  function prefersReducedMotion() {
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function visibleItems() {
    return Array.prototype.filter.call(
      document.querySelectorAll(".feed-item"),
      function (li) {
        return li.offsetParent !== null;
      },
    );
  }

  function moveCursor(delta) {
    var items = visibleItems();
    if (!items.length) return;
    var current = items.indexOf(document.querySelector(".feed-item.lb-cursor"));
    cursor =
      current === -1 ? (delta > 0 ? 0 : items.length - 1) : current + delta;
    if (cursor < 0) cursor = 0;
    if (cursor > items.length - 1) cursor = items.length - 1;
    items.forEach(function (li) {
      li.classList.remove("lb-cursor");
    });
    var target = items[cursor];
    target.classList.add("lb-cursor");
    target.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }

  function currentItem() {
    return document.querySelector(".feed-item.lb-cursor");
  }

  function isTyping(event) {
    var el = event.target;
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      el.isContentEditable
    );
  }

  var helpOverlay = null;

  function toggleHelp() {
    if (helpOverlay) {
      helpOverlay.remove();
      helpOverlay = null;
      return;
    }
    helpOverlay = document.createElement("div");
    helpOverlay.id = "lb-help";
    helpOverlay.setAttribute("role", "dialog");
    helpOverlay.setAttribute("aria-label", "Keyboard shortcuts");
    helpOverlay.innerHTML =
      "<div id='lb-help-card'>" +
      "<h3>Keyboard shortcuts</h3>" +
      "<dl>" +
      "<dt>j / k</dt><dd>next / previous article</dd>" +
      "<dt>o &middot; Enter</dt><dd>open the selected article</dd>" +
      "<dt>s</dt><dd>save / unsave the selected article</dd>" +
      "<dt>m</dt><dd>mark the selected article read / unread</dd>" +
      "<dt>u</dt><dd>hide articles you have read</dd>" +
      "<dt>v</dt><dd>show saved articles only</dd>" +
      "<dt>/</dt><dd>focus the search box</dd>" +
      "<dt>g / G</dt><dd>jump to top / bottom</dd>" +
      "<dt>Esc</dt><dd>close this panel, clear selection</dd>" +
      "<dt>?</dt><dd>toggle this panel</dd>" +
      "</dl>" +
      "<p class='lb-help-foot'>Read state and saved articles are stored in this browser only.</p>" +
      "</div>";
    helpOverlay.addEventListener("click", function (event) {
      if (event.target === helpOverlay) toggleHelp();
    });
    document.body.appendChild(helpOverlay);
  }

  document.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "Escape") {
      if (helpOverlay) {
        toggleHelp();
        return;
      }
      if (isTyping(event)) {
        event.target.blur();
        return;
      }
      var sel = currentItem();
      if (sel) sel.classList.remove("lb-cursor");
      return;
    }

    if (isTyping(event)) return;

    switch (event.key) {
      case "j":
        event.preventDefault();
        moveCursor(1);
        break;
      case "k":
        event.preventDefault();
        moveCursor(-1);
        break;
      case "o":
      case "Enter": {
        var item = currentItem();
        if (!item) return;
        var a = item.querySelector(".feed-item-link a[href]");
        if (!a) return;
        event.preventDefault();
        markRead(a.href, true);
        applyState(item);
        refreshDock();
        window.open(a.href, "_blank", "noopener");
        break;
      }
      case "s": {
        var si = currentItem();
        if (!si) return;
        event.preventDefault();
        var sa = si.querySelector(".lb-star");
        if (sa) sa.click();
        break;
      }
      case "m": {
        var mi = currentItem();
        if (!mi) return;
        event.preventDefault();
        var murl = mi.getAttribute("data-lb-url");
        if (!murl) return;
        markRead(murl, !readMap[murl]);
        applyState(mi);
        refreshDock();
        break;
      }
      case "u":
        event.preventDefault();
        if (hideReadBtn) hideReadBtn.click();
        break;
      case "v":
        event.preventDefault();
        if (savedBtn) savedBtn.click();
        break;
      case "/": {
        var search = document.querySelector("#filter-search input");
        if (!search) return;
        event.preventDefault();
        search.focus();
        search.select();
        break;
      }
      case "g":
        event.preventDefault();
        window.scrollTo({
          top: 0,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
        break;
      case "G":
        event.preventDefault();
        window.scrollTo({
          top: document.body.scrollHeight,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
        break;
      case "?":
        event.preventDefault();
        toggleHelp();
        break;
    }
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    buildProgressBar();
    buildDock();

    var app = document.getElementById("app");
    if (app) {
      new MutationObserver(schedule).observe(app, {
        childList: true,
        subtree: true,
      });
    }

    // Switching theme does `body.setAttribute("class", "")`, which drops our
    // filter classes along with the old theme class. Put them back.
    new MutationObserver(function () {
      var body = document.body;
      var stale =
        body.classList.contains("lb-hide-read") !== !!prefs.hideRead ||
        body.classList.contains("lb-saved-only") !== !!prefs.savedOnly;
      if (stale) applyFilters();
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

    schedule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
