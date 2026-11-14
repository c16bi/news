/*
 * offline.js - the service worker, and knowing when the network is gone.
 *
 * The worker itself is sw.js at the site root. Loading the feed already
 * routes every day file and picture through it, so by the time the page has
 * rendered, everything on it is cached; nothing extra needs requesting here.
 */

import { basePath } from "./data.js";

export function trackConnectivity() {
  const update = () =>
    document.body.classList.toggle("lb-offline", !navigator.onLine);
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

export function registerWorker(toast) {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost")
    return;

  const base = basePath();
  navigator.serviceWorker
    .register(base + "sw.js", { scope: base })
    .then((registration) => {
      // Only prompt when an update replaces a worker; a first install has
      // nothing to reload for.
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing || !navigator.serviceWorker.controller) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed") {
            toast("A newer version of the page is available.", "Reload", () =>
              location.reload(),
            );
          }
        });
      });
    })
    .catch(() => {
      /* offline support is optional - never block the page on it */
    });
}

export async function updateWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  } catch (e) {
    /* best effort */
  }
}
