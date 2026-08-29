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
  /* default theme                                                       */
  /* ------------------------------------------------------------------ */

  // The SPA reads its theme from localStorage at startup and falls back to
  // "default". This runs first (classic script, ahead of the deferred module),
  // so seeding the key here changes the first-visit theme without touching the
  // bundle - and only when the reader has never chosen one, so an explicit
  // pick, including "Default Theme", is always respected afterwards.
  var THEME_KEY = "liveboat-default-theme";
  var DEFAULT_THEME = "seabreeze";
  try {
    if (localStorage.getItem(THEME_KEY) === null) {
      localStorage.setItem(THEME_KEY, DEFAULT_THEME);
    }
  } catch (e) {
    /* private mode - the SPA falls back to its own default */
  }

  /* ------------------------------------------------------------------ */
  /* layouts                                                             */
  /* ------------------------------------------------------------------ */

  // Each layout is pure CSS keyed off a data attribute on <body>; the DOM the
  // SPA renders is identical in all of them. An attribute rather than a class
  // because switching theme clears body.className.
  var LAYOUTS = [
    { id: "compact", label: "Compact", hint: "Dense one-line rows" },
    {
      id: "cards",
      label: "Cards",
      hint: "Roomy cards, multi-column when wide",
    },
    {
      id: "digest",
      label: "Digest",
      hint: "Lead story per section, rest listed",
    },
    { id: "reader", label: "Reader", hint: "Minimal, generous type, no chips" },
    {
      id: "discover",
      label: "Discover",
      hint: "Image-led cards, best on a phone",
    },
  ];

  // Only this layout pulls in remote images, so nothing is fetched unless the
  // reader actually asks for it.
  function layoutWantsImages() {
    return currentLayout() === "discover";
  }

  function layoutIds() {
    return LAYOUTS.map(function (l) {
      return l.id;
    });
  }

  function currentLayout() {
    return layoutIds().indexOf(prefs.layout) === -1 ? "compact" : prefs.layout;
  }

  function applyLayout() {
    document.body.setAttribute("data-lb-layout", currentLayout());
    schedule();
    if (!layoutTabs) return;
    var buttons = layoutTabs.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute("data-lb-layout-id") === currentLayout();
      buttons[i].setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  var layoutTabs = null;

  function buildLayoutTabs() {
    layoutTabs = document.createElement("div");
    layoutTabs.id = "lb-layout-tabs";
    layoutTabs.setAttribute("role", "tablist");
    layoutTabs.setAttribute("aria-label", "Article layout");

    LAYOUTS.forEach(function (layout) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("data-lb-layout-id", layout.id);
      b.textContent = layout.label;
      b.title = layout.hint;
      b.addEventListener("click", function () {
        prefs.layout = layout.id;
        save("prefs", prefs);
        applyLayout();
      });
      layoutTabs.appendChild(b);
    });

    document.body.appendChild(layoutTabs);
    applyLayout();
  }

  function cycleLayout(delta) {
    var ids = layoutIds();
    var next = (ids.indexOf(currentLayout()) + delta + ids.length) % ids.length;
    prefs.layout = ids[next];
    save("prefs", prefs);
    applyLayout();
  }

  /* ------------------------------------------------------------------ */
  /* feed metadata harvesting                                            */
  /* ------------------------------------------------------------------ */

  // url -> {date: unix seconds, len: content length, feed: display title}
  var meta = Object.create(null);
  var metaDirty = false;

  // Enclosure mime types in these feeds are unreliable - mostly absent or
  // "text/plain" even for JPEGs - so the extension is what decides.
  var IMAGE_RE = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;

  function imageFor(item) {
    // lbImage is added at build time by scripts/harvest_images.py, which reads
    // the article's og:image for the roughly half of these feeds that publish
    // no media in their RSS. Absent for anything it could not reach, so the
    // enclosure stays the fallback and no image at all stays valid.
    var harvested = (item.lbImage || "").trim();
    if (harvested) return harvested;
    var url = (item.enclosureUrl || "").trim();
    if (!url) return "";
    var mime = item.enclosureMime || "";
    if (mime.indexOf("image/") === 0) return url;
    return IMAGE_RE.test(url) ? url : "";
  }

  function harvest(payload) {
    if (!payload || !payload.items || !payload.items.length) return;
    var feedName = payload.displayTitle || payload.title || "";
    for (var i = 0; i < payload.items.length; i++) {
      var it = payload.items[i];
      if (!it || !it.url || meta[it.url]) continue;
      meta[it.url] = {
        date: it.date || 0,
        feed: feedName,
        img: imageFor(it),
        content: it.content || "",
      };
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
  /* publisher logos                                                     */
  /* ------------------------------------------------------------------ */

  /* Neither newsboat nor Liveboat keeps the RSS channel <image>, so the only
     place a masthead can come from is the publisher's own site. We ask them
     directly rather than going through a favicon service - no third party
     learns what you read, and a refusal simply falls back to the monogram.

     apple-touch-icon is tried first because it is normally 180px; favicon.ico
     is often 16px and looks poor scaled up. The outcome per domain is cached
     in localStorage, so failed probes are not repeated on later visits. */

  var iconCache = load("icons", {});
  var iconPending = Object.create(null);
  var ICON_TTL_DAYS = 30;

  (function pruneIcons() {
    var cutoff = Math.floor(now / 1000) - ICON_TTL_DAYS * 86400;
    var changed = false;
    for (var d in iconCache) {
      if (!iconCache[d] || !(iconCache[d].t > cutoff)) {
        delete iconCache[d];
        changed = true;
      }
    }
    if (changed) save("icons", iconCache);
  })();

  function knownIcon(domain) {
    var hit = iconCache[domain];
    return hit && hit.url ? hit.url : "";
  }

  function resolveIcon(domain) {
    if (!domain || iconPending[domain]) return;
    if (Object.prototype.hasOwnProperty.call(iconCache, domain)) return;
    if (!navigator.onLine) return;

    iconPending[domain] = true;
    var candidates = [
      "https://" + domain + "/apple-touch-icon.png",
      "https://" + domain + "/apple-touch-icon-precomposed.png",
      "https://" + domain + "/favicon.ico",
    ];
    var i = 0;

    function remember(url) {
      iconCache[domain] = { url: url, t: Math.floor(Date.now() / 1000) };
      save("icons", iconCache);
      delete iconPending[domain];
      if (url) schedule();
    }

    (function attempt() {
      if (i >= candidates.length) {
        remember("");
        return;
      }
      var url = candidates[i++];
      var probe = new Image();
      probe.onload = function () {
        // A 16px favicon is worse than the monogram at chip size.
        if (probe.naturalWidth >= 32) remember(url);
        else attempt();
      };
      probe.onerror = attempt;
      probe.src = url;
    })();
  }

  /* The monogram stays in the DOM as the resting state; a resolved logo is
     layered over it, so nothing flashes empty and offline still shows a chip. */
  function paintBadge(badge, domain) {
    var url = knownIcon(domain);
    var img = badge.querySelector(".lb-source-icon");

    if (!url) {
      if (img) img.remove();
      badge.classList.remove("lb-has-icon");
      resolveIcon(domain);
      return;
    }
    if (img) return;

    img = document.createElement("img");
    img.className = "lb-source-icon";
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", function () {
      img.remove();
      badge.classList.remove("lb-has-icon");
      // A failure while offline says nothing about the publisher - remembering
      // it would blank a perfectly good logo until the cache expires.
      if (navigator.onLine) {
        iconCache[domain] = { url: "", t: Math.floor(Date.now() / 1000) };
        save("icons", iconCache);
      }
    });
    img.src = url;
    badge.appendChild(img);
    badge.classList.add("lb-has-icon");
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

  /* Thumbnails exist only while an image layout is active. A failed load
     removes the element rather than leaving a broken frame - roughly half the
     feeds here carry no enclosure at all, and remote CDNs may refuse
     hotlinking. */
  function syncThumb(li, info) {
    var existing = li.querySelector(".lb-thumb");
    if (!layoutWantsImages() || !info || !info.img) {
      if (existing) existing.remove();
      li.classList.remove("lb-has-image");
      return;
    }
    if (existing) return;

    var img = document.createElement("img");
    img.className = "lb-thumb";
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.addEventListener("error", function () {
      img.remove();
      li.classList.remove("lb-has-image");
    });
    img.src = info.img;
    li.insertBefore(img, li.firstChild);
    li.classList.add("lb-has-image");
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
      badge.style.setProperty("--lb-hue", hueFor(domain));
      var mono = document.createElement("span");
      mono.className = "lb-source-mono";
      mono.textContent = monogram(domain);
      badge.appendChild(mono);

      var label = document.createElement("span");
      label.className = "lb-source-label";
      label.textContent = domain;

      domainEl.appendChild(badge);
      domainEl.appendChild(label);
    }

    var badgeEl = domainEl && domainEl.querySelector(".lb-source-badge");
    if (badgeEl) paintBadge(badgeEl, domainEl.title || "");

    // --- timestamp + reading time ---
    var info = meta[url];
    var timeEl = li.querySelector(".lb-time");
    if (info && info.date) {
      if (!timeEl) {
        timeEl = document.createElement("time");
        timeEl.className = "lb-time";
        li.insertBefore(timeEl, li.firstChild);
      }
      // A row decorated before its feed JSON arrived carries the placeholder
      // class; clear it now that there is a real date to show.
      timeEl.classList.remove("lb-time-pending");
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

    syncThumb(li, info);

    // --- save-for-later button ---
    if (!li.querySelector(".lb-star")) {
      var star = document.createElement("button");
      star.type = "button";
      star.className = "lb-star";
      star.setAttribute("aria-pressed", savedMap[url] ? "true" : "false");
      star.title = "Save for later (s)";
      star.setAttribute("aria-label", "Save for later");
      star.innerHTML = "<span aria-hidden='true'>★</span>";
      star.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        // Vue reuses <li> nodes between renders, so the URL must be read from
        // the DOM at click time - a closure variable can point at whichever
        // article happened to occupy this row when the button was created.
        var current = li.getAttribute("data-lb-url");
        if (!current) return;
        var link = li.querySelector(".feed-item-link a[href]");
        var dom = cleanDomain(
          (li.querySelector(".lb-source-label") || {}).textContent,
        );
        var wasSaved = !!savedMap[current];
        toggleSaved(current, link ? link.textContent.trim() : "", dom);
        // In the saved-only view an unsaved row would vanish mid-click, which
        // reads as "nothing happened". Keep it on screen until the filter is
        // next re-applied.
        if (wasSaved && prefs.savedOnly) li.classList.add("lb-just-unsaved");
        else li.classList.remove("lb-just-unsaved");
        syncRows(current);
        refreshDock();
      });
      li.appendChild(star);
    }

    if (!li.hasAttribute("data-lb-bound")) {
      li.setAttribute("data-lb-bound", "");
      var onOpen = function () {
        var current = li.getAttribute("data-lb-url");
        if (!current) return;
        markRead(current, true);
        syncRows(current);
        refreshDock();
      };
      anchor.addEventListener("click", function (event) {
        // Modified clicks always belong to the browser.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          onOpen();
          return;
        }
        if (inAppReadingOn()) {
          event.preventDefault();
          openSheet(li);
          return;
        }
        onOpen();
      });
      // Middle click / cmd-click open in a background tab without firing click.
      anchor.addEventListener("auxclick", function (event) {
        if (event.button === 1) onOpen();
      });
    }

    applyState(li);
  }

  /* The same article appears in both a query feed and its source feed, so a
     state change has to reach every row showing that URL, not just the one
     that was clicked. */
  function syncRows(url) {
    var rows = document.querySelectorAll(
      '[data-lb-url="' + url.replace(/"/g, '\\"') + '"]',
    );
    for (var i = 0; i < rows.length; i++) applyState(rows[i]);
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

  var dock, hideReadBtn, savedBtn, newBadge, topBtn, readerBtn;

  function setPref(key, value) {
    prefs[key] = value;
    save("prefs", prefs);
  }

  function applyFilters() {
    document.body.classList.toggle("lb-hide-read", !!prefs.hideRead);
    document.body.classList.toggle("lb-saved-only", !!prefs.savedOnly);
    document.body.classList.toggle("lb-scrolled", window.scrollY > 240);
    var reprieved = document.querySelectorAll(".lb-just-unsaved");
    for (var i = 0; i < reprieved.length; i++) {
      reprieved[i].classList.remove("lb-just-unsaved");
    }
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

    readerBtn = makeDockButton(
      "&#9744;",
      "Open articles inside the app (r)",
      function () {
        setPref("inAppReader", !inAppReadingOn());
        paintReaderBtn();
      },
    );

    var helpBtn = makeDockButton("?", "Keyboard shortcuts (?)", toggleHelp);

    newBadge = document.createElement("span");
    newBadge.id = "lb-new-badge";
    newBadge.hidden = true;

    dock.appendChild(newBadge);
    dock.appendChild(savedBtn);
    dock.appendChild(hideReadBtn);
    dock.appendChild(readerBtn);
    dock.appendChild(topBtn);
    dock.appendChild(helpBtn);
    document.body.appendChild(dock);
    applyFilters();
    paintReaderBtn();
  }

  function paintReaderBtn() {
    if (!readerBtn) return;
    readerBtn.setAttribute("aria-pressed", inAppReadingOn() ? "true" : "false");
    readerBtn.title = inAppReadingOn()
      ? "Articles open in a preview inside the app (r)"
      : "Articles open directly in the browser (r)";
  }

  /* A filter that hides every article looks identical to a broken page, and
     the only way out was a keyboard shortcut that phones do not have. Say what
     happened and offer a way back. */
  function refreshEmptyState() {
    var el = document.getElementById("lb-empty");
    var filtering = !!(prefs.savedOnly || prefs.hideRead);
    var items = document.querySelectorAll(".feed-item");
    var anyVisible = Array.prototype.some.call(items, function (li) {
      return li.offsetParent !== null;
    });

    if (!filtering || !items.length || anyVisible) {
      if (el) el.remove();
      return;
    }

    var heading = prefs.savedOnly
      ? "No saved articles yet"
      : "You have read everything here";
    var detail = prefs.savedOnly
      ? "Tap the \u2605 on any article to save it for later."
      : "Turn the filter off to see articles you have already opened.";

    if (!el) {
      el = document.createElement("div");
      el.id = "lb-empty";
      var h = document.createElement("p");
      h.className = "lb-empty-title";
      var d = document.createElement("p");
      d.className = "lb-empty-detail";
      var b = document.createElement("button");
      b.type = "button";
      b.className = "lb-empty-action";
      b.textContent = "Show all articles";
      b.addEventListener("click", function () {
        setPref("savedOnly", false);
        setPref("hideRead", false);
        applyFilters();
        schedule();
      });
      el.appendChild(h);
      el.appendChild(d);
      el.appendChild(b);
      var app = document.getElementById("app");
      (app || document.body).appendChild(el);
    }
    el.querySelector(".lb-empty-title").textContent = heading;
    el.querySelector(".lb-empty-detail").textContent = detail;
  }

  function refreshDock() {
    refreshEmptyState();
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
    var lastY = window.scrollY;
    function update() {
      ticking = false;
      var y = window.scrollY;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var pct = max > 0 ? (y / max) * 100 : 0;
      bar.style.width = pct.toFixed(2) + "%";
      document.body.classList.toggle("lb-scrolled", y > 240);

      // Screen space is scarce on a phone and the floating controls sit on top
      // of the feed. Tuck them away while reading down, bring them back on any
      // upward scroll. The 6px threshold ignores scroll jitter.
      if (Math.abs(y - lastY) > 6) {
        document.body.classList.toggle(
          "lb-chrome-hidden",
          y > lastY && y > 160,
        );
        lastY = y;
      }
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
      "<dt>r</dt><dd>open articles in-app or in the browser</dd>" +
      "<dt>[ / ]</dt><dd>previous / next article layout</dd>" +
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
      if (sheet) {
        closeSheet();
        return;
      }
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
      case "r":
        event.preventDefault();
        setPref("inAppReader", !inAppReadingOn());
        paintReaderBtn();
        break;
      case "[":
        event.preventDefault();
        cycleLayout(-1);
        break;
      case "]":
        event.preventDefault();
        cycleLayout(1);
        break;
      case "?":
        event.preventDefault();
        toggleHelp();
        break;
    }
  });

  /* ------------------------------------------------------------------ */
  /* in-app article sheet                                                */
  /* ------------------------------------------------------------------ */

  /* Opening a link from an installed PWA hands you to the system browser and
     you lose your place. This keeps you inside the app: the sheet shows the
     summary the feed already gave us, with the original one tap away.

     The summary is all we have - these are RSS feeds, not full articles - so
     the sheet is a preview, not a reader. */

  var sheet = null;
  var sheetLastFocus = null;

  function inAppReadingOn() {
    return prefs.inAppReader !== false;
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    document.body.classList.remove("lb-sheet-open");
    if (sheetLastFocus && sheetLastFocus.focus) sheetLastFocus.focus();
    sheetLastFocus = null;
  }

  function shareArticle(url, title) {
    if (navigator.share) {
      navigator.share({ title: title, url: url }).catch(function () {});
      return;
    }
    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(url)
        .then(function () {
          toast("Link copied to clipboard.");
        })
        .catch(function () {});
    }
  }

  function openSheet(li) {
    var url = li.getAttribute("data-lb-url");
    var link = li.querySelector(".feed-item-link a[href]");
    if (!url || !link) return;

    closeSheet();
    sheetLastFocus = document.activeElement;

    var info = meta[url] || {};
    var title = link.textContent.trim();
    var domain = cleanDomain(
      (li.querySelector(".lb-source-label") || {}).textContent,
    );
    var author =
      (li.querySelector(".feed-item-author") || {}).textContent || "";

    sheet = document.createElement("div");
    sheet.id = "lb-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", title);

    var panel = document.createElement("div");
    panel.id = "lb-sheet-panel";

    var head = document.createElement("div");
    head.className = "lb-sheet-head";
    var badge = document.createElement("span");
    badge.className = "lb-source-badge";
    badge.style.setProperty("--lb-hue", hueFor(domain));
    var badgeMono = document.createElement("span");
    badgeMono.className = "lb-source-mono";
    badgeMono.textContent = monogram(domain);
    badge.appendChild(badgeMono);
    paintBadge(badge, domain);
    var src = document.createElement("span");
    src.className = "lb-sheet-source";
    src.textContent = info.feed ? info.feed + " · " + domain : domain;
    var close = document.createElement("button");
    close.type = "button";
    close.className = "lb-sheet-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "\u00d7";
    close.addEventListener("click", closeSheet);
    head.appendChild(badge);
    head.appendChild(src);
    head.appendChild(close);

    var h = document.createElement("h2");
    h.className = "lb-sheet-title";
    h.textContent = title;

    var sub = document.createElement("p");
    sub.className = "lb-sheet-meta";
    sub.textContent =
      (info.date ? fullDate(info.date) : "") +
      (author ? " · " + author.trim() : "");

    var body = document.createElement("div");
    body.className = "lb-sheet-body";
    // The feed's own summary, as text - never inserted as markup.
    var summary = String(info.content || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    body.textContent = summary || "No preview available for this article.";

    var actions = document.createElement("div");
    actions.className = "lb-sheet-actions";

    var open = document.createElement("a");
    open.className = "lb-sheet-primary";
    open.href = link.href;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Open original \u2197";
    open.addEventListener("click", function () {
      markRead(url, true);
      syncRows(url);
      refreshDock();
    });

    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "lb-sheet-action";
    var paintSave = function () {
      saveBtn.textContent = savedMap[url] ? "\u2605 Saved" : "\u2606 Save";
      saveBtn.setAttribute("aria-pressed", savedMap[url] ? "true" : "false");
    };
    paintSave();
    saveBtn.addEventListener("click", function () {
      toggleSaved(url, title, domain);
      paintSave();
      syncRows(url);
      refreshDock();
    });

    var shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.className = "lb-sheet-action";
    shareBtn.textContent = "Share";
    shareBtn.addEventListener("click", function () {
      shareArticle(link.href, title);
    });

    actions.appendChild(open);
    actions.appendChild(saveBtn);
    actions.appendChild(shareBtn);

    panel.appendChild(head);

    if (info.img) {
      var hero = document.createElement("img");
      hero.className = "lb-sheet-image";
      hero.alt = "";
      hero.loading = "lazy";
      hero.addEventListener("error", function () {
        hero.remove();
      });
      hero.src = info.img;
      panel.appendChild(hero);
    }

    panel.appendChild(h);
    panel.appendChild(sub);
    panel.appendChild(body);
    panel.appendChild(actions);
    sheet.appendChild(panel);

    sheet.addEventListener("click", function (event) {
      if (event.target === sheet) closeSheet();
    });

    document.body.appendChild(sheet);
    document.body.classList.add("lb-sheet-open");
    close.focus();

    markRead(url, true);
    syncRows(li.getAttribute("data-lb-url"));
    refreshDock();
  }

  /* ------------------------------------------------------------------ */
  /* offline support                                                     */
  /* ------------------------------------------------------------------ */

  var toastEl = null;

  function toast(message, actionLabel, onAction) {
    if (toastEl) toastEl.remove();
    toastEl = document.createElement("div");
    toastEl.id = "lb-toast";
    toastEl.setAttribute("role", "status");

    var text = document.createElement("span");
    text.textContent = message;
    toastEl.appendChild(text);

    if (actionLabel) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = actionLabel;
      button.addEventListener("click", onAction);
      toastEl.appendChild(button);
    }

    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "lb-toast-close";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", function () {
      if (toastEl) toastEl.remove();
      toastEl = null;
    });
    toastEl.appendChild(dismiss);

    document.body.appendChild(toastEl);
  }

  function trackConnectivity() {
    function update() {
      document.body.classList.toggle("lb-offline", !navigator.onLine);
    }
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.hostname !== "localhost")
      return;

    var base = window.sitePath || "/";
    if (base.charAt(base.length - 1) !== "/") base += "/";

    /* When a new worker claims the page, the assets already on screen were
       served by the old one. Reload once so everything comes from the new
       worker - without this the swap takes an extra visit or two to show up,
       which is indistinguishable from "the update never arrived". */
    var reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    navigator.serviceWorker
      .register(base + "sw.js", { scope: base })
      .then(function (registration) {
        // Only prompt when an update replaces an existing worker; the very
        // first install has nothing to reload for.
        registration.addEventListener("updatefound", function () {
          var installing = registration.installing;
          if (!installing || !navigator.serviceWorker.controller) return;
          installing.addEventListener("statechange", function () {
            if (installing.state === "installed") {
              toast(
                "A newer version of the page is available.",
                "Reload",
                function () {
                  location.reload();
                },
              );
            }
          });
        });
      })
      .catch(function () {
        /* offline support is optional - never block the page on it */
      });
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    buildProgressBar();
    buildDock();
    buildLayoutTabs();
    trackConnectivity();
    registerServiceWorker();

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
