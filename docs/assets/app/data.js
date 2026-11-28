/*
 * data.js - load the feed.
 *
 * The build writes docs/river/: an index, one file per day, and the story
 * groups (see scripts/build_river.py). Each day file is requested with its
 * content hash in the URL, so a day that has not changed is the same URL as
 * last time and comes straight from the cache. After an hourly rebuild a
 * visit downloads today, anything a publisher edited, and the index - not the
 * whole feed again.
 *
 * If the river is missing - a build where that step failed - this falls back
 * to the per-feed files Liveboat itself writes, so the page still works.
 */

import { domainOf, safeHref, safeSrc } from "./format.js";

export function basePath() {
  const base = window.sitePath || "/";
  return base.endsWith("/") ? base : base + "/";
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(url + " -> " + response.status);
  return response.json();
}

export async function fetchIndex() {
  try {
    const index = await getJson(basePath() + "river/index.json", {
      cache: "no-cache",
    });
    if (index && index.format === 1 && Array.isArray(index.days)) return index;
  } catch (e) {
    /* offline with nothing cached, or an older build without a river */
  }
  return null;
}

function finish(raw, feeds) {
  const url = safeHref(raw.url);
  if (!url || !raw.title) return null;
  const feed = feeds[raw.feed] || {};
  return {
    url,
    title: String(raw.title),
    date: Number(raw.date) || 0,
    feed: raw.feed || "",
    feedTitle: feed.title || "",
    tags: Array.isArray(feed.tags) ? feed.tags : [],
    author: raw.author || "",
    image: safeSrc(raw.image || ""),
    text: raw.text || "",
    domain: domainOf(url),
  };
}

async function loadRiver(index) {
  const base = basePath() + "river/";
  const days = await Promise.all(
    index.days.map((d) =>
      getJson(base + d.day + ".json?v=" + d.v).catch(() => []),
    ),
  );
  let clusters = [];
  if (index.clusters && index.clusters.n) {
    clusters = await getJson(
      base + "clusters.json?v=" + index.clusters.v,
    ).catch(() => []);
  }
  const items = [];
  for (const day of days) {
    for (const raw of day) {
      const item = finish(raw, index.feeds || {});
      if (item) items.push(item);
    }
  }
  return { items, clusters, feeds: index.feeds || {} };
}

/* --- fallback: Liveboat's own per-feed files --- */

const IMAGE_RE = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;

function legacyImage(item) {
  const harvested = (item.lbImage || "").trim();
  if (harvested) return harvested;
  const url = (item.enclosureUrl || "").trim();
  if (!url) return "";
  if ((item.enclosureMime || "").startsWith("image/")) return url;
  return IMAGE_RE.test(url) ? url : "";
}

function legacyText(item) {
  if (item.lbText) return item.lbText;
  return String(item.content || "")
    .replace(/<\/(p|div|li|h[1-6]|blockquote)\s*>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

async function loadLegacy() {
  const declared = (window.feeds || []).filter((f) => f && !f.isQuery);
  const feeds = {};
  for (const f of declared) {
    feeds[f.id] = {
      title: f.displayTitle || f.title || "",
      tags: f.tags || [],
      link: f.feedLink || "",
    };
  }
  const base = basePath() + "feeds/";
  const files = await Promise.all(
    declared.map((f) =>
      getJson(base + f.id + ".json?bt=" + window.buildTime).catch(() => null),
    ),
  );
  const seen = new Set();
  const items = [];
  files.forEach((file, i) => {
    if (!file || !Array.isArray(file.items)) return;
    for (const raw of file.items) {
      if (!raw || seen.has(raw.url)) continue;
      seen.add(raw.url);
      const item = finish(
        {
          url: raw.url,
          title: raw.title,
          date: raw.date,
          feed: declared[i].id,
          author: raw.author,
          image: legacyImage(raw),
          text: legacyText(raw),
        },
        feeds,
      );
      if (item) items.push(item);
    }
  });
  return { items, clusters: [], feeds };
}

/* Everything the page needs, newest first. Pass an index already fetched to
   avoid asking for it twice. */
export async function loadFeed(prefetched) {
  const index = prefetched || (await fetchIndex());
  const result = index ? await loadRiver(index) : await loadLegacy();
  result.items.sort((a, b) => b.date - a.date || (a.url < b.url ? -1 : 1));
  result.built = index ? index.built : Number(window.buildTime) || 0;
  result.iconsVersion = index && index.icons ? index.icons.v : "";
  result.fromRiver = !!index;
  return result;
}

export async function loadIcons(version) {
  try {
    const map = await getJson(
      basePath() + "feeds/icons.json" + (version ? "?v=" + version : ""),
      version ? undefined : { cache: "no-cache" },
    );
    return map && typeof map === "object" ? map : {};
  } catch (e) {
    return {};
  }
}
