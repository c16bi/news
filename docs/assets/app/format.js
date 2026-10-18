/* format.js - dates, domains and the little derived labels rows carry. */

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

export function relativeTime(unixSeconds, nowMs = Date.now()) {
  let delta = Math.floor(nowMs / 1000) - unixSeconds;
  if (delta < 0) delta = 0;
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return Math.floor(delta / MINUTE) + "m";
  if (delta < DAY) return Math.floor(delta / HOUR) + "h";
  if (delta < 7 * DAY) return Math.floor(delta / DAY) + "d";
  if (delta < 365 * DAY) return Math.floor(delta / (7 * DAY)) + "w";
  return Math.floor(delta / (365 * DAY)) + "y";
}

export function fullDate(unixSeconds) {
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

/* Days are the reader's days, not UTC's: a story published at 1am in London
   belongs under that morning, not the evening before. */
export function dayKey(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export function dayLabel(unixSeconds, nowMs = Date.now()) {
  if (dayKey(unixSeconds) === dayKey(nowMs / 1000)) return "Today";
  if (dayKey(unixSeconds) === dayKey(nowMs / 1000 - DAY)) return "Yesterday";
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "2-digit",
  });
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\d?\./, "");
  } catch (e) {
    return "";
  }
}

// Deterministic hue so each source keeps a stable colour across reloads.
export function hueFor(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

export function monogram(domain) {
  const base = domain.split(".")[0] || domain;
  return base.slice(0, 2).toUpperCase();
}

export function prefersReducedMotion() {
  return !!(
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* Only links a reader can follow. A feed that sends `javascript:` in a link
   must not get it into an href. */
export function safeHref(url) {
  return /^https?:\/\//i.test(url || "") ? url : "";
}

/* Pictures over https, or from this site itself; an http picture on an https
   page is blocked as mixed content anyway. */
export function safeSrc(url) {
  if (!url) return "";
  if (/^https:\/\//i.test(url)) return url;
  if (url.charAt(0) === "/" && url.charAt(1) !== "/") return url;
  return "";
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
