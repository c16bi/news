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

  /* One mixed feed rather than 24 stacked source sections.
     The SPA calls this "firehose" and already implements it properly: a single
     list, in time order, deduplicated across the query feeds and the source
     feeds they draw from. It was reachable only from a button sitting in a row
     of item-count options, where it read as "how much" rather than "how it is
     arranged". Seeded here, ahead of the deferred bundle, so a first visit gets
     it - and only when nothing has been chosen, so a later preference sticks. */
  var FILTER_KEY = "liveboat-default-filters";
  try {
    if (localStorage.getItem(FILTER_KEY) === null) {
      localStorage.setItem(
        FILTER_KEY,
        JSON.stringify({
          itemCount: 20,
          daysBackCount: 1,
          filterByDays: false,
          firehose: true,
        }),
      );
    }
  } catch (e) {
    /* as above */
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
    {
      id: "e1",
      label: "Mixed",
      hint: "Newest first, pictures where they exist",
    },
    {
      id: "e2",
      label: "Leads",
      hint: "Each day opens with its best picture",
    },
  ];

  // Layouts that show pictures. Everything else leaves remote images alone, so
  // nothing is fetched unless the reader has actually asked to see them.
  var IMAGE_LAYOUTS = { discover: 1, e1: 1, e2: 1 };

  function layoutWantsImages() {
    return !!IMAGE_LAYOUTS[currentLayout()];
  }

  // e1 and e2 restyle type and structure but take their colour from whichever
  // theme is selected, like every other layout.
  function editorialLayout() {
    var id = currentLayout();
    return id === "e1" || id === "e2";
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
    document.body.classList.toggle("lb-editorial", editorialLayout());
    schedule();
    if (!layoutTabs) return;
    var buttons = layoutTabs.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute("data-lb-layout-id") === currentLayout();
      buttons[i].setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  var layoutTabs = null;

  function buildLayoutTabs(host) {
    layoutTabs = document.createElement("div");
    layoutTabs.id = "lb-layout-tabs";
    layoutTabs.setAttribute("role", "tablist");
    layoutTabs.setAttribute("aria-label", "Article layout");

    LAYOUTS.forEach(function (layout) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("data-lb-layout-id", layout.id);
      var name = document.createElement("span");
      name.className = "lb-layout-name";
      name.textContent = layout.label;
      var hint = document.createElement("span");
      hint.className = "lb-layout-hint";
      hint.textContent = layout.hint;
      b.appendChild(name);
      b.appendChild(hint);
      b.addEventListener("click", function () {
        prefs.layout = layout.id;
        save("prefs", prefs);
        applyLayout();
      });
      layoutTabs.appendChild(b);
    });

    host.appendChild(layoutTabs);
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

  /* Images that failed to load. A picture can be present in the metadata and
     still not render - the publisher's CDN refuses the referrer, the file has
     gone, the network dropped. Remembering which ones died matters most to e2,
     which promotes a row *because* it has a picture: without this, a lead
     whose image fails stays promoted at full width with nothing in it. Kept in
     memory only, so a genuine outage is retried on the next visit rather than
     written off. */
  var deadImages = Object.create(null);

  function imageFor(item) {
    // lbImage is added at build time by scripts/harvest_images.py, which reads
    // the article's og:image for the roughly half of these feeds that publish
    // no media in their RSS. Absent for anything it could not reach, so the
    // enclosure stays the fallback and no image at all stays valid.
    var harvested = (item.lbImage || "").trim();
    if (harvested && !deadImages[harvested]) return harvested;
    var url = (item.enclosureUrl || "").trim();
    if (!url || deadImages[url]) return "";
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

  /* Logos the build resolved, read from the publisher's own page head. This
     is authoritative where it has an answer; the browser probe below stays as
     the fallback for publishers that refuse the build but not the reader. */
  var buildIcons = Object.create(null);

  function loadBuildIcons() {
    var base = (window.sitePath || "/").replace(/\/?$/, "/");
    fetch(base + "feeds/icons.json", { cache: "no-cache" })
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (map) {
        if (!map || typeof map !== "object") return;
        var found = false;
        for (var d in map) {
          if (typeof map[d] === "string" && map[d]) {
            buildIcons[d] = map[d];
            found = true;
          }
        }
        if (found) schedule();
      })
      .catch(function () {
        /* offline, or an older build with no icons.json - probe as before */
      });
  }

  function knownIcon(domain) {
    if (buildIcons[domain]) return buildIcons[domain];
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
  /* e2 shows one picture per section, so it loads one picture per section.
     Every other row in that layout is a text line and never asks the network
     for anything. */
  function wantsThumb(li) {
    if (!layoutWantsImages()) return false;
    if (currentLayout() === "e2") return li.classList.contains("lb-lead");
    return true;
  }

  function syncThumb(li, info) {
    var existing = li.querySelector(".lb-thumb");
    if (!wantsThumb(li) || !info || !info.img) {
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
      // Take it out of the running and re-pick: in e2 this row may be the
      // section's lead, and a lead with no picture is the one thing that
      // layout must not produce.
      if (info.img && !deadImages[info.img]) {
        deadImages[info.img] = 1;
        info.img = imageFor({ lbImage: "", enclosureUrl: "" });
        li.classList.remove("lb-lead");
        schedule();
      }
    });
    img.src = info.img;
    li.insertBefore(img, li.firstChild);
    li.classList.add("lb-has-image");
  }

  /* ------------------------------------------------------------------ */
  /* swipe gestures                                                      */
  /* ------------------------------------------------------------------ */

  /* Swipe right saves, swipe left marks read - the two things worth doing to a
     headline without opening it, on the hand already holding the phone.

     Two rules keep this smooth, and the first version broke both.

     One: the finger must never wait on layout. `touch-action: pan-y` hands
     vertical scrolling to the compositor, so there is no preventDefault here;
     and the only thing written during a drag is a transform, batched into one
     rAF per frame. The first version created the hint element, set an
     attribute, toggled a class and rewrote text on every single touchmove -
     four style invalidations a frame on a card carrying a photograph.

     Two: nothing that changes size may change during the drag. The hint is
     built once at bind time and its text is rewritten only when the direction
     or the armed state actually flips, not continuously. */

  var SWIPE_TRIGGER = 64; // px of travel that commits the action
  var SWIPE_CLAIM = 10; // px before we decide the gesture is ours
  var SWIPE_MAX = 108; // rubber-band ceiling

  function bindGestures(li) {
    var startX = 0;
    var startY = 0;
    var offset = 0;
    var claimed = false;
    var settled = true;
    var frame = 0;

    // Built once. Creating this mid-drag cost a layout on every frame.
    var hint = document.createElement("span");
    hint.className = "lb-swipe-hint";
    hint.setAttribute("aria-hidden", "true");
    li.appendChild(hint);

    // Last painted state, so the DOM is touched only when it actually changes.
    var shownAction = "";
    var shownArmed = null;

    function paint() {
      frame = 0;
      li.style.transform = offset ? "translate3d(" + offset + "px,0,0)" : "";

      var action = offset > 0 ? "save" : "read";
      var armed = Math.abs(offset) >= SWIPE_TRIGGER;
      if (action === shownAction && armed === shownArmed) return;

      if (action !== shownAction) {
        li.setAttribute("data-lb-swipe", action);
        var url = li.getAttribute("data-lb-url");
        hint.textContent =
          action === "save"
            ? savedMap[url]
              ? "Unsave"
              : "Save"
            : readMap[url]
              ? "Unread"
              : "Read";
        shownAction = action;
      }
      if (armed !== shownArmed) {
        li.classList.toggle("lb-swipe-armed", armed);
        shownArmed = armed;
      }
    }

    function schedulePaint() {
      if (!frame) frame = requestAnimationFrame(paint);
    }

    function reset() {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      offset = 0;
      claimed = false;
      shownAction = "";
      shownArmed = null;
      li.style.transform = "";
      li.classList.remove("lb-swiping", "lb-swipe-armed");
      li.removeAttribute("data-lb-swipe");
    }

    li.addEventListener(
      "touchstart",
      function (event) {
        if (event.touches.length !== 1) {
          settled = true;
          return;
        }
        // A touch that begins on the star is a tap on the star.
        if (event.target.closest && event.target.closest(".lb-star")) {
          settled = true;
          return;
        }
        settled = false;
        claimed = false;
        offset = 0;
        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
      },
      { passive: true },
    );

    li.addEventListener(
      "touchmove",
      function (event) {
        if (settled || event.touches.length !== 1) return;
        var dx = event.touches[0].clientX - startX;
        var dy = event.touches[0].clientY - startY;

        if (!claimed) {
          // Ambiguous until one axis clearly wins; a diagonal drag belongs to
          // the scroller, not to us.
          if (Math.abs(dy) > Math.abs(dx)) {
            settled = true;
            return;
          }
          if (Math.abs(dx) < SWIPE_CLAIM) return;
          claimed = true;
          li.classList.add("lb-swiping");
          // Start measuring from the point the gesture was claimed, so the row
          // does not jump the claim distance the instant it takes over.
          startX += dx < 0 ? -SWIPE_CLAIM : SWIPE_CLAIM;
          dx = event.touches[0].clientX - startX;
        }

        // Resist past the trigger point so the row cannot be flung off screen
        // and the commit distance stays findable by feel.
        offset = dx;
        if (Math.abs(offset) > SWIPE_TRIGGER) {
          var over = Math.abs(offset) - SWIPE_TRIGGER;
          offset =
            (offset < 0 ? -1 : 1) *
            Math.min(SWIPE_MAX, SWIPE_TRIGGER + over * 0.3);
        }
        schedulePaint();
      },
      { passive: true },
    );

    function finish() {
      if (settled || !claimed) {
        reset();
        return;
      }
      var committed = Math.abs(offset) >= SWIPE_TRIGGER;
      var action = offset > 0 ? "save" : "read";
      reset();
      if (!committed) return;

      // Read the URL now, not at bind time: Vue recycles these rows.
      var url = li.getAttribute("data-lb-url");
      if (!url) return;

      if (navigator.vibrate) {
        try {
          navigator.vibrate(8);
        } catch (e) {
          /* vibration is a nicety and is blocked in some contexts */
        }
      }

      if (action === "save") {
        var link = li.querySelector(".feed-item-link a[href]");
        var dom = cleanDomain(
          (li.querySelector(".lb-source-label") || {}).textContent,
        );
        var wasSaved = !!savedMap[url];
        toggleSaved(url, link ? link.textContent.trim() : "", dom);
        if (wasSaved && prefs.savedOnly) li.classList.add("lb-just-unsaved");
        toast(wasSaved ? "Removed from saved" : "Saved", "Undo", function () {
          toggleSaved(url, link ? link.textContent.trim() : "", dom);
          syncRows(url);
          refreshDock();
        });
      } else {
        var wasRead = !!readMap[url];
        markRead(url, !wasRead);
        // Marking read under an active hide-read filter removes the row from
        // under the thumb; say what happened and offer it back.
        if (!wasRead && prefs.hideRead) li.classList.add("lb-just-unsaved");
        toast(wasRead ? "Marked unread" : "Marked read", "Undo", function () {
          markRead(url, wasRead);
          syncRows(url);
          refreshDock();
        });
      }
      syncRows(url);
      refreshDock();
    }

    li.addEventListener("touchend", finish, { passive: true });
    li.addEventListener("touchcancel", finish, { passive: true });
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
      bindGestures(li);
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
  /* section leads (e2)                                                  */
  /* ------------------------------------------------------------------ */

  /* e2 opens each section with a picture. The one it picks is the newest story
     in that section that actually has an image, which is rarely the newest
     story overall - so the lead has to be hoisted past its neighbours.

     That hoisting is done with CSS `order`, never by moving nodes. The SPA owns
     this subtree and re-renders it from its own state; a node moved here would
     be moved back, and worse, the row would carry another article's decoration
     when it landed. Setting `order` on a flex column leaves the DOM exactly as
     Vue wrote it.

     Sections where nothing has a picture - Bloomberg, the FT, the Economist,
     which publish no images and refuse the build's request for one - are
     labelled rather than left looking broken. */
  /* Whether this row has a picture is answered from the harvested metadata,
     not from whether an <img> is on the page. That ordering matters: e2 loads
     a picture only for the row it is about to promote, so asking the DOM would
     mean loading two hundred images to discover which five to show. */
  function itemImage(li) {
    var anchor = li.querySelector(".feed-item-link a[href]");
    if (!anchor) return "";
    var info = meta[anchor.href];
    if (!info || !info.img || deadImages[info.img]) return "";
    return info.img;
  }

  function markSections() {
    /* What counts as "a section" depends on how the feed is arranged. Grouped
       by source, it is the source - e2 opens each publication with its best
       picture. Merged into one list there are no sources to open, so the unit
       becomes the day: the SPA still buckets a firehose by date, and leading
       each day is the same idea applied to the shape actually on screen.
       Without this, e2 in a merged feed would promote one photograph to the
       very top and leave four hundred text lines under it. */
    var wrappers = document.querySelectorAll(
      mergedFeedOn() ? ".feed-item-group" : ".feed-wrapper",
    );
    var leadWanted = currentLayout() === "e2";

    for (var i = 0; i < wrappers.length; i++) {
      var wrapper = wrappers[i];
      var items = wrapper.querySelectorAll(".feed-item");
      var lead = null;
      var withImage = 0;

      for (var j = 0; j < items.length; j++) {
        var li = items[j];
        var hasImage = !!itemImage(li);
        if (hasImage) withImage++;
        // Only a visible row may lead: a filter can hide the natural pick.
        if (leadWanted && !lead && hasImage && li.offsetParent !== null) {
          lead = li;
        }
      }

      for (var k = 0; k < items.length; k++) {
        items[k].classList.toggle("lb-lead", items[k] === lead);
      }

      wrapper.classList.toggle("lb-section-nopix", leadWanted && !withImage);
      // The note names a publication that never sends pictures, which only
      // means something when the sections are publications.
      syncNoPixNote(
        wrapper,
        leadWanted && !withImage && items.length > 0 && !mergedFeedOn(),
      );
    }
  }

  function syncNoPixNote(wrapper, wanted) {
    var title = wrapper.querySelector(".feed-title");
    if (!title) return;
    var note = title.querySelector(".lb-nopix-note");
    if (!wanted) {
      if (note) note.remove();
      return;
    }
    if (note) return;
    note = document.createElement("span");
    note.className = "lb-nopix-note";
    note.textContent = "no pictures in this feed";
    title.appendChild(note);
  }

  /* ------------------------------------------------------------------ */
  /* scheduling: re-decorate whenever the SPA re-renders                 */
  /* ------------------------------------------------------------------ */

  var frame = null;

  function decorateAll() {
    frame = null;
    metaDirty = false;
    // Leads first: which row leads decides which row loads a picture, so the
    // per-item pass needs the answer before it runs.
    try {
      markSections();
    } catch (e) {
      /* leads are decoration; never let them break the feed */
    }
    var items = document.querySelectorAll(".feed-item");
    for (var i = 0; i < items.length; i++) {
      try {
        decorateItem(items[i]);
      } catch (e) {
        /* one bad row must not stop the rest */
      }
    }
    ensureNativeProxies();
    refreshDock();
  }

  function schedule() {
    if (frame !== null) return;
    frame = requestAnimationFrame(decorateAll);
  }

  /* ------------------------------------------------------------------ */
  /* floating dock                                                       */
  /* ------------------------------------------------------------------ */

  var dock, newBadge;

  function setPref(key, value) {
    prefs[key] = value;
    save("prefs", prefs);
  }

  function applyFilters() {
    document.body.classList.toggle("lb-hide-read", !!prefs.hideRead);
    document.body.classList.toggle("lb-saved-only", !!prefs.savedOnly);
    // With in-app reading on, tapping a headline opens a sheet showing the
    // same summary the inline expand button reveals. Two controls for one
    // thing, and the inline one sets in the middle of the headline.
    document.body.classList.toggle("lb-inapp", inAppReadingOn());
    document.body.classList.toggle("lb-scrolled", window.scrollY > 240);
    var reprieved = document.querySelectorAll(".lb-just-unsaved");
    for (var i = 0; i < reprieved.length; i++) {
      reprieved[i].classList.remove("lb-just-unsaved");
    }
    syncSettings();
  }

  /* Everything that is a setting lives behind one button.

     Before this there were two stacked bars pinned over the feed - five filter
     buttons and five layout tabs - plus the template's own theme dropdown and
     time-range row at the top. Four rows of controls around one column of
     headlines, all of it permanently on screen for choices made roughly never.
     The controls are all still here; they are just no longer the first thing
     you see. Swipes now cover the two that get used constantly, so the button
     is genuinely a settings button rather than a hidden toolbar. */

  function makeToggleRow(label, detail, isOn, onToggle) {
    var row = document.createElement("button");
    row.type = "button";
    row.className = "lb-set-row";
    row.setAttribute("role", "switch");

    var text = document.createElement("span");
    text.className = "lb-set-text";
    var name = document.createElement("span");
    name.className = "lb-set-name";
    name.textContent = label;
    var hint = document.createElement("span");
    hint.className = "lb-set-hint";
    hint.textContent = detail;
    text.appendChild(name);
    text.appendChild(hint);

    var knob = document.createElement("span");
    knob.className = "lb-set-knob";
    knob.setAttribute("aria-hidden", "true");

    row.appendChild(text);
    row.appendChild(knob);
    row.addEventListener("click", function () {
      onToggle();
      row.setAttribute("aria-checked", isOn() ? "true" : "false");
      syncSettings();
    });
    row.setAttribute("aria-checked", isOn() ? "true" : "false");
    row._lbSync = function () {
      row.setAttribute("aria-checked", isOn() ? "true" : "false");
    };
    return row;
  }

  function sheetSection(host, title, slug) {
    var h = document.createElement("h3");
    h.className = "lb-set-heading";
    h.textContent = title;
    host.appendChild(h);
    var box = document.createElement("div");
    box.className = "lb-set-group" + (slug ? " lb-set-group-" + slug : "");
    host.appendChild(box);
    return box;
  }

  /* The template's own theme <select> and time-range buttons are hidden rather
     than removed, and driven from here. They belong to the SPA: it re-renders
     them and reads their state, so the reliable way to change one is to change
     the real control and let the SPA notice, exactly as a click would. */
  function nativeThemeSelect() {
    return document.querySelector("#theme-selector select");
  }

  function syncThemeRow() {
    var row = document.getElementById("lb-theme-row");
    if (!row) return;
    var select = row.querySelector("select");
    var native = nativeThemeSelect();
    if (select && native && select.value !== native.value) {
      select.value = native.value;
    }
  }

  function buildThemeRow(host) {
    var native = nativeThemeSelect();
    if (!native) return;

    var row = document.createElement("div");
    row.id = "lb-theme-row";
    row.className = "lb-set-row lb-set-row-static";

    var text = document.createElement("span");
    text.className = "lb-set-text";
    var name = document.createElement("span");
    name.className = "lb-set-name";
    name.textContent = "Theme";
    var hint = document.createElement("span");
    hint.className = "lb-set-hint";
    hint.textContent = "Applies to every layout";
    text.appendChild(name);
    text.appendChild(hint);

    var select = document.createElement("select");
    select.className = "lb-set-select";
    select.setAttribute("aria-label", "Theme");
    for (var i = 0; i < native.options.length; i++) {
      var opt = document.createElement("option");
      opt.value = native.options[i].value;
      opt.textContent = native.options[i].textContent;
      select.appendChild(opt);
    }
    select.value = native.value;
    select.addEventListener("change", function () {
      native.value = select.value;
      native.dispatchEvent(new Event("change", { bubbles: true }));
    });

    row.appendChild(text);
    row.appendChild(select);
    host.appendChild(row);
    syncThemeRow();
  }

  /* The template's own row is Firehose / Last day / Last 50 / Last 20, four
     mutually exclusive buttons. But Firehose is not a quantity like the other
     three - it is the difference between one mixed feed and a stack of
     per-source sections. Presented as a fourth amount, it read as noise. So it
     is split out as its own switch here, and the three real amounts only
     appear when it is off, since they have no meaning while it is on. */
  function nativeRangeButton(match) {
    var boxes = document.querySelectorAll(".filter-container .filter-box");
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i].querySelector("button");
      if (b && match.test((b.textContent || "").trim())) return b;
    }
    return null;
  }

  function mergedFeedOn() {
    var b = nativeRangeButton(/firehose/i);
    return !!(b && b.classList.contains("selected"));
  }

  function setMergedFeed(on) {
    var b = nativeRangeButton(on ? /firehose/i : /last 20/i);
    if (b && !b.classList.contains("selected")) b.click();
    // The list is rebuilt asynchronously; re-read once it has been.
    requestAnimationFrame(function () {
      requestAnimationFrame(syncSettings);
    });
  }

  function buildMergeRow(host) {
    var row = makeToggleRow(
      "One mixed feed",
      "Every source in one list, newest first",
      mergedFeedOn,
      function () {
        setMergedFeed(!mergedFeedOn());
      },
    );
    row.id = "lb-merge-row";
    host.appendChild(row);
  }

  function buildRangeRow(host) {
    var boxes = document.querySelectorAll(".filter-container .filter-box");
    if (!boxes.length) return;

    var row = document.createElement("div");
    row.id = "lb-range-row";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "How much to show");

    for (var i = 0; i < boxes.length; i++) {
      (function (nativeBtn) {
        if (!nativeBtn) return;
        var b = document.createElement("button");
        b.type = "button";
        b.className = "lb-range-btn";
        b.textContent = (nativeBtn.textContent || "").trim();
        b.addEventListener("click", function () {
          nativeBtn.click();
          window.setTimeout(syncSettings, 0);
        });
        b._lbNative = nativeBtn;
        row.appendChild(b);
      })(boxes[i].querySelector("button"));
    }
    host.appendChild(row);
  }

  /* Kept apart from syncSettings so it can also run from the render loop: the
     SPA re-renders after a click and only then marks the new button selected,
     so anything read straight after a click reads the old state. */
  function syncMergedClass() {
    var merged = mergedFeedOn();
    if (document.body.classList.contains("lb-merged") !== merged) {
      document.body.classList.toggle("lb-merged", merged);
    }
    return merged;
  }

  function syncRangeRow() {
    var merged = syncMergedClass();

    var heading = document.getElementById("lb-amount-heading");
    if (heading) heading.hidden = merged;

    var row = document.getElementById("lb-range-row");
    if (!row) return;
    row.hidden = merged;
    var buttons = row.querySelectorAll(".lb-range-btn");
    for (var i = 0; i < buttons.length; i++) {
      var native = buttons[i]._lbNative;
      var on = !!(native && native.classList.contains("selected"));
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  /* The theme <select> and the range buttons are rendered by the SPA, which
     has usually not run by the time the sheet is built - and re-renders them
     later besides. So the mirrors are created the first time their originals
     actually exist, and re-created if a render throws them away. */
  function ensureNativeProxies() {
    if (!settingsSheet) return;
    var look = settingsSheet.querySelector(".lb-set-group-appearance");
    if (look && !document.getElementById("lb-theme-row")) buildThemeRow(look);

    var show = settingsSheet.querySelector(".lb-set-group-show");
    var range = document.getElementById("lb-range-row");
    if (show && (!range || !range.querySelector(".lb-range-btn"))) {
      if (range) range.remove();
      buildRangeRow(show);
    }
  }

  function syncSettings() {
    var rows = document.querySelectorAll(".lb-set-row[role='switch']");
    for (var i = 0; i < rows.length; i++) {
      if (rows[i]._lbSync) rows[i]._lbSync();
    }
    syncRangeRow();
    syncThemeRow();
  }

  var settingsSheet = null;

  function settingsOpen() {
    return !!(settingsSheet && !settingsSheet.hidden);
  }

  function toggleSettings(force) {
    if (!settingsSheet) return;
    var open = typeof force === "boolean" ? force : !settingsOpen();
    settingsSheet.hidden = !open;
    document.body.classList.toggle("lb-settings-open", open);
    if (dock) dock.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      syncSettings();
      var first = settingsSheet.querySelector("button, select");
      if (first) first.focus();
    } else if (dock) {
      dock.focus();
    }
  }

  function buildSettings() {
    settingsSheet = document.createElement("div");
    settingsSheet.id = "lb-settings";
    settingsSheet.hidden = true;
    settingsSheet.setAttribute("role", "dialog");
    settingsSheet.setAttribute("aria-modal", "false");
    settingsSheet.setAttribute("aria-label", "Settings");

    var panel = document.createElement("div");
    panel.className = "lb-set-panel";
    settingsSheet.appendChild(panel);

    var grabber = document.createElement("div");
    grabber.className = "lb-set-grabber";
    grabber.setAttribute("aria-hidden", "true");
    panel.appendChild(grabber);

    buildLayoutTabs(sheetSection(panel, "Layout"));

    var reading = sheetSection(panel, "Reading");
    reading.appendChild(
      makeToggleRow(
        "Saved only",
        "Just the articles you starred",
        function () {
          return !!prefs.savedOnly;
        },
        function () {
          setPref("savedOnly", !prefs.savedOnly);
          if (prefs.savedOnly) setPref("hideRead", false);
          applyFilters();
        },
      ),
    );
    reading.appendChild(
      makeToggleRow(
        "Hide read",
        "Drop articles you have already opened",
        function () {
          return !!prefs.hideRead;
        },
        function () {
          setPref("hideRead", !prefs.hideRead);
          if (prefs.hideRead) setPref("savedOnly", false);
          applyFilters();
        },
      ),
    );
    reading.appendChild(
      makeToggleRow(
        "Open in app",
        "Preview articles here instead of a new tab",
        inAppReadingOn,
        function () {
          setPref("inAppReader", !inAppReadingOn());
          paintReaderBtn();
        },
      ),
    );

    buildMergeRow(reading);

    var show = sheetSection(panel, "How many per source", "show");
    var amountHeading = show.previousElementSibling;
    if (amountHeading) amountHeading.id = "lb-amount-heading";
    buildRangeRow(show);

    var look = sheetSection(panel, "Appearance", "appearance");
    buildThemeRow(look);

    // The GitHub / RSS / OPML links upstream floats out of a zero-height box
    // in the header. Same links, somewhere they fit.
    var links = document.querySelectorAll(
      "#icons-aggro a[href], #side-buttons a[href]",
    );
    if (links.length) {
      var out = sheetSection(panel, "This feed");
      out.id = "lb-out-links";
      var names = {
        "icon-github": "Source",
        "icon-rss": "RSS",
        "icon-opml": "OPML",
      };
      for (var li = 0; li < links.length; li++) {
        (function (src) {
          var name = names[src.id];
          if (!name) return;
          var a = document.createElement("a");
          a.className = "lb-set-row lb-set-row-static";
          a.href = src.href;
          a.target = "_blank";
          a.rel = "noopener";
          var text = document.createElement("span");
          text.className = "lb-set-text";
          var n = document.createElement("span");
          n.className = "lb-set-name";
          n.textContent = name;
          text.appendChild(n);
          a.appendChild(text);
          out.appendChild(a);
        })(links[li]);
      }
    }

    var foot = document.createElement("div");
    foot.className = "lb-set-foot";

    var topLink = document.createElement("button");
    topLink.type = "button";
    topLink.className = "lb-set-link";
    topLink.textContent = "Back to top";
    topLink.addEventListener("click", function () {
      toggleSettings(false);
      window.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });

    var helpLink = document.createElement("button");
    helpLink.type = "button";
    helpLink.className = "lb-set-link";
    helpLink.textContent = "Gestures & shortcuts";
    helpLink.addEventListener("click", function () {
      toggleSettings(false);
      toggleHelp();
    });

    foot.appendChild(topLink);
    foot.appendChild(helpLink);
    panel.appendChild(foot);

    // Tapping the scrim closes; taps inside the panel must not.
    settingsSheet.addEventListener("click", function (event) {
      if (event.target === settingsSheet) toggleSettings(false);
    });
    panel.addEventListener("click", function (event) {
      event.stopPropagation();
    });

    document.body.appendChild(settingsSheet);
  }

  /* "Am I looking at the current build?" had no answer on the page. The
     template's own header carried an "Updated on ..." line, and hiding that
     chrome took the answer with it - which matters more here than in most
     sites, because a service worker can serve a perfectly good page that is
     hours old. window.buildTime is stamped into the HTML by the generator, so
     it describes the build actually being rendered, not the time now.

     Tapping it asks the worker to check for a newer one. */
  function buildStamp() {
    var when = Number(window.buildTime || 0);
    if (!when) return;

    var stamp = document.createElement("button");
    stamp.id = "lb-build-stamp";
    stamp.type = "button";

    var label = document.createElement("span");
    label.className = "lb-stamp-text";
    stamp.appendChild(label);

    function paint() {
      label.textContent = "Updated " + relativeTime(when);
      stamp.title =
        "Built " + fullDate(when) + " - tap to check for a newer one";
    }
    paint();
    // The page can sit open for hours; a stale "Updated 2m ago" would be
    // exactly the reassurance it should not be giving.
    window.setInterval(paint, 60000);

    stamp.addEventListener("click", function () {
      label.textContent = "Checking\u2026";
      var done = function (message) {
        label.textContent = message;
        window.setTimeout(paint, 2500);
      };
      if (!("serviceWorker" in navigator)) {
        window.location.reload();
        return;
      }
      navigator.serviceWorker
        .getRegistration()
        .then(function (reg) {
          if (!reg) {
            window.location.reload();
            return;
          }
          // If a new worker takes over, the inline snippet in the HTML reloads
          // the page for us, so this only has to report the no-change case.
          return reg.update().then(function () {
            done(
              reg.installing || reg.waiting ? "Updating\u2026" : "Up to date",
            );
          });
        })
        .catch(function () {
          done("Check failed");
        });
    });

    var host = document.querySelector("#app .header-title");
    (host || document.body).appendChild(stamp);
  }

  function buildDock() {
    dock = document.createElement("button");
    dock.id = "lb-dock";
    dock.type = "button";
    dock.title = "Settings";
    dock.setAttribute("aria-label", "Settings");
    dock.setAttribute("aria-expanded", "false");
    dock.innerHTML = "<span aria-hidden='true'>⋯</span>";

    newBadge = document.createElement("span");
    newBadge.id = "lb-new-badge";
    newBadge.hidden = true;

    dock.addEventListener("click", function () {
      toggleSettings();
    });

    document.body.appendChild(newBadge);
    document.body.appendChild(dock);
    buildSettings();
    applyFilters();
  }

  function paintReaderBtn() {
    document.body.classList.toggle("lb-inapp", inAppReadingOn());
    syncSettings();
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

  /* Says which filter is on, right where the filtered list starts, and clears
     it when tapped. Placed before the feed rather than in the settings sheet:
     a filter you have forgotten about looks exactly like a feed that has
     stopped working, so it has to be visible without opening anything. */
  function refreshFilterChip() {
    var chip = document.getElementById("lb-filter-chip");
    var label = prefs.savedOnly
      ? "Saved only"
      : prefs.hideRead
        ? "Hiding read"
        : "";

    if (!label) {
      if (chip) chip.remove();
      return;
    }

    if (!chip) {
      chip = document.createElement("button");
      chip.id = "lb-filter-chip";
      chip.type = "button";
      chip.addEventListener("click", function () {
        setPref("savedOnly", false);
        setPref("hideRead", false);
        applyFilters();
        schedule();
      });
      var host = document.querySelector("#app .filter-container");
      if (host && host.parentNode) {
        host.parentNode.insertBefore(chip, host.nextSibling);
      } else {
        return;
      }
    }
    chip.firstChild
      ? (chip.firstChild.nodeValue = label)
      : chip.appendChild(document.createTextNode(label));
    chip.title = "Clear this filter";
    chip.setAttribute("aria-label", label + " - tap to clear");
  }

  function refreshDock() {
    refreshEmptyState();
    refreshFilterChip();
    // decorateAll runs on every SPA render, which is exactly when the answer
    // to "is this merged?" can have changed under us.
    syncSettings();
    if (!newBadge) return;
    var count = document.querySelectorAll(".feed-item.lb-new").length;
    if (count > 0 && lastVisit) {
      newBadge.hidden = false;
      newBadge.textContent = count + " new";
      newBadge.title = "Articles published since your last visit";
    } else {
      newBadge.hidden = true;
    }
    if (dock) {
      var saved = Object.keys(savedMap).length;
      dock.classList.toggle("lb-has-items", saved > 0);
      dock.title = saved ? "Settings — " + saved + " saved" : "Settings";
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
    helpOverlay.setAttribute("aria-label", "Gestures and keyboard shortcuts");
    helpOverlay.innerHTML =
      "<div id='lb-help-card'>" +
      "<h3>On a touchscreen</h3>" +
      "<dl>" +
      "<dt>swipe right</dt><dd>save / unsave the article</dd>" +
      "<dt>swipe left</dt><dd>mark it read / unread</dd>" +
      "<dt>tap</dt><dd>open it</dd>" +
      "</dl>" +
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
      "<dt>,</dt><dd>open settings</dd>" +
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
      if (settingsOpen()) {
        toggleSettings(false);
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
        setPref("hideRead", !prefs.hideRead);
        if (prefs.hideRead) setPref("savedOnly", false);
        applyFilters();
        break;
      case "v":
        event.preventDefault();
        setPref("savedOnly", !prefs.savedOnly);
        if (prefs.savedOnly) setPref("hideRead", false);
        applyFilters();
        break;
      case ",":
        event.preventDefault();
        toggleSettings();
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
    buildStamp();
    loadBuildIcons();
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
