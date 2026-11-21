/*
 * logos.js - publisher logos for the source chips.
 *
 * The build reads each publisher's declared icon from its own page head
 * (scripts/harvest_icons.py) and that answer wins. Publishers that refuse the
 * build often do not refuse the reader, so for those the browser tries the
 * three well-known paths itself and remembers the outcome per domain. A
 * coloured monogram is the resting state underneath, so nothing ever shows
 * empty - including offline.
 */

import { store } from "./store.js";
import { el, hueFor, monogram, safeSrc } from "./format.js";

const ICON_TTL_DAYS = 30;
const buildIcons = Object.create(null);
const pending = Object.create(null);
const waiting = new Set();

(function prune() {
  const cutoff = Math.floor(Date.now() / 1000) - ICON_TTL_DAYS * 86400;
  let changed = false;
  for (const d of Object.keys(store.icons)) {
    if (!store.icons[d] || !(store.icons[d].t > cutoff)) {
      delete store.icons[d];
      changed = true;
    }
  }
  if (changed) store.saveIcons();
})();

export function setBuildIcons(map) {
  for (const [domain, url] of Object.entries(map || {})) {
    const safe = typeof url === "string" ? safeSrc(url) : "";
    if (safe) buildIcons[domain] = safe;
  }
  // Repaint every chip that was waiting on an answer.
  for (const badge of waiting) paint(badge);
}

function known(domain) {
  if (buildIcons[domain]) return buildIcons[domain];
  const hit = store.icons[domain];
  return hit && hit.url ? hit.url : "";
}

function remember(domain, url) {
  store.icons[domain] = { url, t: Math.floor(Date.now() / 1000) };
  store.saveIcons();
}

function probe(domain) {
  if (!domain || pending[domain]) return;
  if (Object.prototype.hasOwnProperty.call(store.icons, domain)) return;
  if (!navigator.onLine) return;
  pending[domain] = true;
  const candidates = [
    "https://" + domain + "/apple-touch-icon.png",
    "https://" + domain + "/apple-touch-icon-precomposed.png",
    "https://" + domain + "/favicon.ico",
  ];
  let i = 0;
  (function attempt() {
    if (i >= candidates.length) {
      remember(domain, "");
      delete pending[domain];
      return;
    }
    const url = candidates[i++];
    const img = new Image();
    img.onload = () => {
      // A 16px favicon is worse than the monogram at chip size.
      if (img.naturalWidth >= 32) {
        remember(domain, url);
        delete pending[domain];
        for (const badge of waiting) paint(badge);
      } else attempt();
    };
    img.onerror = attempt;
    img.src = url;
  })();
}

function paint(badge) {
  const domain = badge.dataset.domain || "";
  const url = known(domain);
  if (!url) {
    waiting.add(badge);
    probe(domain);
    return;
  }
  waiting.delete(badge);
  if (badge.querySelector(".lb-source-icon")) return;
  const img = el("img", "lb-source-icon");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("error", () => {
    img.remove();
    badge.classList.remove("lb-has-icon");
    // A failure while offline says nothing about the publisher.
    if (navigator.onLine && !buildIcons[domain]) remember(domain, "");
  });
  img.src = url;
  badge.appendChild(img);
  badge.classList.add("lb-has-icon");
}

export function badge(domain) {
  const node = el("span", "lb-source-badge");
  node.dataset.domain = domain;
  node.style.setProperty("--lb-hue", hueFor(domain));
  node.appendChild(el("span", "lb-source-mono", monogram(domain)));
  paint(node);
  return node;
}

/* Rows are thrown away on every re-render; forget their chips with them. */
export function forgetDetached() {
  for (const b of waiting) if (!b.isConnected) waiting.delete(b);
}
