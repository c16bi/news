/*
 * feed.js - render the river.
 *
 * The markup deliberately matches what the previous front end produced -
 * the same element structure and class names - because every layout in
 * custom.css was designed and tuned against it. Owning the renderer changes
 * what decides the markup, not the markup the design depends on.
 *
 * What is new is the shape of the list:
 *   - one feed, newest first, grouped by the reader's own day
 *   - the same story from several outlets collapses into one row, with the
 *     others behind an "also covered by" line underneath (see stories.py)
 *   - saved articles, a single source, and search are views of their own,
 *     shown flat, so nothing is ever hidden inside a group while filtering
 */

import { store, IMAGE_LAYOUTS, LEAD_LAYOUTS } from "./store.js";
import { dayKey, dayLabel, el, fullDate, relativeTime } from "./format.js";
import { badge, forgetDetached } from "./logos.js";

// Pictures that failed to load this session; never offered again until reload.
const dead = new Set();

// A cluster leads with its newest report, unless one only slightly older has
// a picture and the newest does not - in a picture layout that is the
// difference between a photograph and a text line for the same story.
const PICTURE_PREFERENCE = 6 * 3600;

export function parseQuery(raw) {
  const tags = [];
  const words = [];
  const parts = String(raw || "").match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const part of parts) {
    if (part.toLowerCase().startsWith("t:")) {
      part
        .slice(2)
        .split(",")
        .map((t) => t.replace(/["']+/g, "").trim().toLowerCase())
        .filter(Boolean)
        .forEach((t) => tags.push(t));
    } else {
      const word = part.replace(/"/g, "").trim().toLowerCase();
      if (word) words.push(word);
    }
  }
  return { tags, words };
}

/* Same rules as before: `t:` restricts to sources carrying that tag, and every
   remaining word must appear in the headline, the source name or the domain. */
export function matches(item, query) {
  if (query.tags.length) {
    const own = item.tags.map((t) => t.toLowerCase());
    if (!query.tags.some((t) => own.includes(t))) return false;
  }
  if (!query.words.length) return true;
  const hay = (item.title + " " + item.feedTitle + " " + item.domain)
    .toLowerCase()
    .split(/\s+/);
  return query.words.every((w) => hay.some((h) => h.includes(w)));
}

function choosePrimary(members) {
  const newest = members[0];
  if (newest.image) return newest;
  const pictured = members.find(
    (m) => m.image && newest.date - m.date <= PICTURE_PREFERENCE,
  );
  return pictured || newest;
}

export function createFeed(app) {
  const root = el("div", "feed-list");
  const wrapper = el("div", "feed-wrapper");
  const title = el("div", "feed-title");
  const titleLink = el("a");
  titleLink.href = "#";
  title.appendChild(titleLink);
  const body = el("div");
  wrapper.appendChild(title);
  wrapper.appendChild(body);
  root.appendChild(wrapper);

  titleLink.addEventListener("click", (event) => {
    event.preventDefault();
    window.scrollTo({ top: 0 });
  });

  let lastView = "river";

  function view() {
    if (app.query) return "search";
    if (store.prefs.savedOnly) return "saved";
    if (store.prefs.source && app.data.feeds[store.prefs.source])
      return "source";
    return "river";
  }

  function savedItems() {
    return Object.keys(store.saved)
      .map((url) => {
        const live = app.data.byUrl.get(url);
        if (live) return live;
        // Saved before it aged out of the feed: keep what we stored.
        const s = store.saved[url];
        return {
          url,
          title: s.title || url,
          date: s.date || s.t || 0,
          feed: "",
          feedTitle: "",
          tags: [],
          author: "",
          image: "",
          text: "",
          domain: s.domain || "",
        };
      })
      .sort((a, b) => b.date - a.date);
  }

  function baseList() {
    if (store.prefs.savedOnly) return savedItems();
    const source = store.prefs.source;
    if (source && app.data.feeds[source]) {
      return app.data.items.filter((i) => i.feed === source);
    }
    return app.data.items;
  }

  function entries(list, grouped) {
    if (!grouped) return list.map((item) => ({ item, also: [] }));
    const used = new Set();
    const out = [];
    for (const item of list) {
      if (used.has(item.url)) continue;
      const group = app.data.clusterOf.get(item.url);
      if (!group) {
        out.push({ item, also: [] });
        continue;
      }
      const members = group
        .map((u) => app.data.byUrl.get(u))
        .filter(Boolean)
        .sort((a, b) => b.date - a.date);
      members.forEach((m) => used.add(m.url));
      const primary = choosePrimary(members);
      out.push({ item: primary, also: members.filter((m) => m !== primary) });
    }
    return out.sort((a, b) => b.item.date - a.item.date);
  }

  /* --- one row --- */

  function addThumb(li, item) {
    if (!item.image || dead.has(item.image) || li.querySelector(".lb-thumb"))
      return false;
    const img = el("img", "lb-thumb");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.addEventListener("error", () => {
      dead.add(item.image);
      img.remove();
      li.classList.remove("lb-has-image");
      // A lead is promoted because it has a picture; one whose picture died
      // must hand the lead on, not sit at full width with nothing in it.
      if (li.classList.contains("lb-lead")) {
        li.classList.remove("lb-lead");
        const group = li.closest(".feed-item-group");
        if (group) markLead(group);
      }
    });
    img.src = item.image;
    li.insertBefore(img, li.firstChild);
    li.classList.add("lb-has-image");
    return true;
  }

  function row(item) {
    const li = el("li", "feed-item");
    li.dataset.lbUrl = item.url;

    const time = el("time", "lb-time", relativeTime(item.date));
    time.dateTime = new Date(item.date * 1000).toISOString();
    time.title = fullDate(item.date);
    time.dataset.ts = String(item.date);
    li.appendChild(time);

    const link = el("span", "feed-item-link");
    const a = el("a", null, item.title);
    a.href = item.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.addEventListener("click", (event) => app.open(item, event));
    a.addEventListener("auxclick", (event) => {
      if (event.button === 1) app.markOpened(item.url);
    });
    link.appendChild(a);
    li.appendChild(link);

    if (item.author)
      li.appendChild(el("span", "feed-item-author", " by " + item.author));

    if (item.domain) {
      const domain = el("span", "feed-item-domain");
      domain.title = item.domain;
      domain.appendChild(badge(item.domain));
      domain.appendChild(el("span", "lb-source-label", item.domain));
      li.appendChild(domain);
    }

    const star = el("button", "lb-star");
    star.type = "button";
    star.title = "Save for later (s)";
    star.setAttribute("aria-label", "Save for later");
    star.appendChild(el("span", null, "★")).setAttribute("aria-hidden", "true");
    star.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      app.toggleSaved(item, li);
    });
    li.appendChild(star);

    app.bindGestures(li, item);
    applyState(li);
    return li;
  }

  function alsoRow(entry) {
    const li = el("li", "lb-also");
    li.dataset.lead = entry.item.url;
    const names = entry.also.map((m) => m.feedTitle || m.domain);
    const toggle = el("button", "lb-also-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.appendChild(el("span", "lb-also-count", "+" + entry.also.length));
    toggle.appendChild(
      el("span", "lb-also-names", "Also covered by " + names.join(", ")),
    );
    const list = el("ul", "lb-also-list");
    list.hidden = true;
    for (const member of entry.also) {
      const item = el("li", "lb-also-item");
      item.dataset.lbUrl = member.url;
      const a = el("a", null, member.title);
      a.href = member.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.addEventListener("click", (event) => app.open(member, event));
      item.appendChild(a);
      item.appendChild(
        el(
          "span",
          "lb-also-meta",
          (member.feedTitle || member.domain) +
            " · " +
            relativeTime(member.date),
        ),
      );
      applyState(item);
      list.appendChild(item);
    }
    toggle.addEventListener("click", () => {
      const open = list.hidden;
      list.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      li.classList.toggle("lb-also-open", open);
    });
    li.appendChild(toggle);
    li.appendChild(list);
    return li;
  }

  /* --- state on rows --- */

  function applyState(node) {
    const url = node.dataset.lbUrl;
    if (!url) return;
    const isRead = store.isRead(url);
    node.classList.toggle("lb-read", isRead);
    node.classList.toggle("lb-saved", store.isSaved(url));
    if (!node.classList.contains("feed-item")) return;
    const item = app.data.byUrl.get(url);
    const fresh = !!(
      item &&
      store.lastVisit &&
      item.date > store.lastVisit &&
      !isRead
    );
    node.classList.toggle("lb-new", fresh);
    const star = node.querySelector(".lb-star");
    if (star)
      star.setAttribute("aria-pressed", store.isSaved(url) ? "true" : "false");
  }

  // The same article can be on screen twice (as a row and inside a group).
  function syncRows(url) {
    const sel = '[data-lb-url="' + CSS.escape(url) + '"]';
    root.querySelectorAll(sel).forEach(applyState);
  }

  /* --- picture leads (e2, f4) --- */

  function markLead(group) {
    const layout = store.layout();
    if (!LEAD_LAYOUTS.has(layout)) return;
    const rows = group.querySelectorAll("li.feed-item");
    let lead = null;
    for (const li of rows) {
      li.classList.remove("lb-lead");
      if (lead) continue;
      if (store.prefs.hideRead && li.classList.contains("lb-read")) continue;
      const item = app.data.byUrl.get(li.dataset.lbUrl);
      if (!item || !item.image || dead.has(item.image)) continue;
      addThumb(li, item);
      lead = li;
    }
    if (lead) lead.classList.add("lb-lead");
    // Thumbnails belong to the lead only; a demoted row gives its picture up.
    for (const li of rows) {
      if (li !== lead) {
        const img = li.querySelector(".lb-thumb");
        if (img) img.remove();
        li.classList.remove("lb-has-image");
      }
    }
    group.classList.toggle("lb-section-nopix", !lead);
  }

  /* --- the whole list --- */

  function render(options = {}) {
    const anchor = options.keepPlace ? captureAnchor() : null;
    const current = view();
    const layout = store.layout();
    const thumbs = IMAGE_LAYOUTS.has(layout) && !LEAD_LAYOUTS.has(layout);

    let list = baseList();
    if (app.query) {
      const q = parseQuery(app.query);
      list = list.filter((i) => matches(i, q));
    }
    const grouped = current === "river" && store.grouping();
    const rows = entries(list, grouped);

    document.body.classList.toggle("lb-merged", current !== "source");
    document.body.classList.toggle("lb-saved-only", !!store.prefs.savedOnly);
    document.body.classList.toggle("lb-hide-read", !!store.prefs.hideRead);
    title.hidden = current !== "source";
    if (current === "source") {
      titleLink.textContent = app.data.feeds[store.prefs.source].title;
    }

    const fragment = document.createDocumentFragment();
    let group = null;
    let ul = null;
    let currentDay = null;
    for (const entry of rows) {
      const key = dayKey(entry.item.date);
      if (key !== currentDay) {
        currentDay = key;
        group = el("div", "feed-item-group");
        group.appendChild(
          el("span", "feed-group-date", dayLabel(entry.item.date)),
        );
        ul = el("ul");
        group.appendChild(ul);
        fragment.appendChild(group);
      }
      const li = row(entry.item);
      if (thumbs) addThumb(li, entry.item);
      ul.appendChild(li);
      if (entry.also.length) ul.appendChild(alsoRow(entry));
    }

    body.replaceChildren(fragment);
    forgetDetached();
    if (LEAD_LAYOUTS.has(layout))
      body.querySelectorAll(".feed-item-group").forEach(markLead);

    if (anchor) restoreAnchor(anchor);
    else if (current !== lastView) window.scrollTo({ top: 0 });
    lastView = current;

    app.stats = { view: current, shown: list.length, groups: rows.length };
    app.refreshChrome();
  }

  /* --- keeping your place across a live refresh --- */

  function captureAnchor() {
    for (const li of root.querySelectorAll("li.feed-item")) {
      const rect = li.getBoundingClientRect();
      if (rect.bottom > 0) return { url: li.dataset.lbUrl, top: rect.top };
    }
    return null;
  }

  function restoreAnchor(anchor) {
    const sel = 'li.feed-item[data-lb-url="' + CSS.escape(anchor.url) + '"]';
    const li = root.querySelector(sel);
    if (!li) return;
    window.scrollBy(0, li.getBoundingClientRect().top - anchor.top);
  }

  /* Relative times go stale on a page left open; refresh them in place. */
  function refreshTimes() {
    const now = Date.now();
    root.querySelectorAll("time.lb-time").forEach((t) => {
      t.textContent = relativeTime(Number(t.dataset.ts), now);
    });
  }

  function visibleRows() {
    return Array.from(root.querySelectorAll("li.feed-item")).filter(
      (li) => li.offsetParent !== null,
    );
  }

  function relead() {
    if (LEAD_LAYOUTS.has(store.layout()))
      root.querySelectorAll(".feed-item-group").forEach(markLead);
  }

  return {
    root,
    render,
    syncRows,
    applyState,
    visibleRows,
    refreshTimes,
    relead,
  };
}
