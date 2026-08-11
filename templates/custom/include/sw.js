/*
 * sw.js — service worker for the Liveboat feed page.
 *
 * Lives at the site root (docs/sw.js) rather than under assets/, because a
 * worker can only control pages at or below its own path and GitHub Pages
 * will not serve the Service-Worker-Allowed header that would relax that.
 *
 * Caching strategy, chosen around the fact that the site is rebuilt hourly
 * and its asset URLs are cache-busted with query strings rather than hashed
 * filenames:
 *
 *   navigation  -> network first, cached shell as the offline fallback
 *   assets/*    -> stale-while-revalidate (instant paint, refresh behind it)
 *   feeds, etc. -> network first, cached copy as the offline fallback
 *
 * That means online you always read current news, and offline you read
 * whatever you last loaded.
 */

/* Bumping this discards every cache from the previous version on activate.
   v1 shipped with a loose asset match that pinned readers to the first build
   its cache ever saw, so those caches must be thrown away, not migrated. */
var VERSION = "v2";
var SHELL_CACHE = VERSION + "-shell";
var DATA_CACHE = VERSION + "-data";
var MAX_DATA_ENTRIES = 60;

var BASE = new URL(self.registration.scope).pathname;

var SHELL_ASSETS = [
  BASE,
  BASE + "assets/index.css",
  BASE + "assets/index.js",
  BASE + "assets/custom.css",
  BASE + "assets/custom.js",
  BASE + "assets/site.webmanifest",
  BASE + "assets/favicon.ico",
  BASE + "assets/favicon-32x32.png",
  BASE + "assets/apple-touch-icon.png",
  BASE + "assets/android-chrome-192x192.png",
  BASE + "assets/android-chrome-512x512.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        // Individually, so one missing optional asset cannot fail the install.
        return Promise.all(
          SHELL_ASSETS.map(function (url) {
            return cache
              .add(new Request(url, { cache: "reload" }))
              .catch(function () {});
          }),
        );
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== SHELL_CACHE && key !== DATA_CACHE;
            })
            .map(function (key) {
              return caches.delete(key);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

/* Keep the data cache from growing without bound; oldest entries go first. */
function trimCache(cacheName, maxEntries) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= maxEntries) return;
      return Promise.all(
        keys.slice(0, keys.length - maxEntries).map(function (key) {
          return cache.delete(key);
        }),
      );
    });
  });
}

function networkFirst(request, cacheName, fallbackUrl) {
  return fetch(request)
    .then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(cacheName).then(function (cache) {
          cache.put(request, copy).then(function () {
            if (cacheName === DATA_CACHE)
              trimCache(DATA_CACHE, MAX_DATA_ENTRIES);
          });
        });
      }
      return response;
    })
    .catch(function () {
      return caches.match(request, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (fallbackUrl)
          return caches.match(fallbackUrl, { ignoreSearch: true });
        return Response.error();
      });
    });
}

/* Drop every other cached variant of this path before storing the new one.
   Liveboat cache-busts with ?bt=<build time>, so without this the cache
   accumulates one entry per build and never lets the old ones go. */
function putAssetFresh(cache, request, response) {
  var path = new URL(request.url).pathname;
  return cache
    .keys()
    .then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return (
              new URL(key.url).pathname === path && key.url !== request.url
            );
          })
          .map(function (key) {
            return cache.delete(key);
          }),
      );
    })
    .then(function () {
      return cache.put(request, response);
    });
}

/* Matching has to be exact, not ignoreSearch.
   ?bt= changes on every build, so an exact match means "same build" - a hit is
   known-current and a new build correctly misses and goes to the network.
   Matching loosely would let the first entry ever cached answer for every
   later build, pinning the reader to it permanently. ignoreSearch survives
   only as the offline fallback, where a stale asset beats none. */
function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (exact) {
      var network = fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            putAssetFresh(cache, request, response.clone());
          }
          return response;
        })
        .catch(function () {
          return cache
            .match(request, { ignoreSearch: true })
            .then(function (any) {
              return any || Response.error();
            });
        });
      return exact || network;
    });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf(BASE) !== 0) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, BASE));
    return;
  }

  if (url.pathname.indexOf(BASE + "assets/") === 0) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  event.respondWith(networkFirst(request, DATA_CACHE));
});

self.addEventListener("message", function (event) {
  if (event.data === "lb-skip-waiting") self.skipWaiting();
});
