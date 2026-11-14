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
 *   navigation   -> network first, cached shell as the offline fallback
 *   assets/*     -> stale-while-revalidate (instant paint, refresh behind it)
 *   river/*?v=   -> cache first; the hash in the URL is the content, so a hit
 *                   is current by definition and a changed day is a new URL
 *   river index  -> network first, cached copy as the offline fallback
 *   pictures     -> cache first, on any origin, capped and quota-safe
 *
 * That means online you always read current news, and offline you read
 * whatever you last loaded.
 *
 * Pictures are the one thing here that is not ours. Every article image is on
 * a publisher's CDN, and the first two versions of this worker declined every
 * cross-origin request, so going offline left a feed of headlines with holes
 * where the photographs had been - which is most of what the picture-led
 * layouts are. They are cached now, with three concessions to the fact that
 * a cross-origin image can only be stored opaquely:
 *
 *   - an opaque response has status 0 and `ok` false, so it cannot be
 *     inspected; a failed request looks exactly like a successful one and is
 *     rejected here by size instead.
 *   - browsers pad opaque entries in quota accounting, by far more than the
 *     bytes involved, so the cache is capped by count and every write is
 *     wrapped: a quota refusal must never break the page.
 *   - only pictures the reader actually scrolled past are stored, which is
 *     what makes the cap meaningful.
 */

/* Bumping this discards every cache from the previous version on activate.
   v1 shipped with a loose asset match that pinned readers to the first build
   its cache ever saw, so those caches must be thrown away, not migrated. */
/* v4: the front end is no longer the prebuilt app, so its assets are new
   files, and the feed now arrives as the river rather than per-feed files. */
var VERSION = "v4";
var SHELL_CACHE = VERSION + "-shell";
var DATA_CACHE = VERSION + "-data";
var IMAGE_CACHE = VERSION + "-img";

/* About forty day files, the index, the story groups and the logo map; older
   versions of each are replaced as they are stored, so this is headroom. */
var MAX_DATA_ENTRIES = 200;
var MAX_IMAGE_ENTRIES = 160;

var BASE = new URL(self.registration.scope).pathname;

var SHELL_ASSETS = [
  BASE,
  BASE + "assets/base.css",
  BASE + "assets/custom.css",
  BASE + "assets/app/main.js",
  BASE + "assets/app/store.js",
  BASE + "assets/app/format.js",
  BASE + "assets/app/data.js",
  BASE + "assets/app/logos.js",
  BASE + "assets/app/feed.js",
  BASE + "assets/app/gestures.js",
  BASE + "assets/app/sheet.js",
  BASE + "assets/app/chrome.js",
  BASE + "assets/app/keys.js",
  BASE + "assets/app/offline.js",
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
              return (
                key !== SHELL_CACHE && key !== DATA_CACHE && key !== IMAGE_CACHE
              );
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

/* Every cache write that could hit the storage quota goes through here. A
   quota refusal is a normal outcome on a phone with a full disk, not an
   error to propagate: the picture still displays from the network response
   that was already returned, it just is not there next time. */
function safePut(cache, request, response) {
  try {
    return cache.put(request, response).catch(function () {});
  } catch (e) {
    return Promise.resolve();
  }
}

/* Pictures, on any origin.
 *
 * Cache first: an article photograph is immutable at its URL, so re-fetching
 * it on every scroll past buys nothing and costs a phone its data.
 *
 * The request is re-issued in no-cors mode when it is cross-origin, which is
 * every publisher CDN. That yields an opaque response - status 0, unreadable
 * headers, unreadable body - which is fine to cache and hand to an <img>, and
 * impossible to inspect.
 *
 * v3 got that wrong. It checked every response's size before caching it, to
 * keep error pages out - but an opaque body reads as zero bytes by design, so
 * every publisher photograph failed the check and none was ever stored. Its
 * test passed only because the stand-in pictures it used were same-origin,
 * and so readable. Opaque responses are now cached as they are; the size
 * check applies only where there is a body to measure. A failed network
 * request rejects rather than resolving, so what reaches the cache is at worst
 * a publisher's error page, which the entry cap eventually evicts. */
var MIN_IMAGE_BYTES = 600;

function cacheFirstImage(request) {
  return caches.open(IMAGE_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;

      var sameOrigin = new URL(request.url).origin === self.location.origin;
      var outbound = sameOrigin
        ? request
        : new Request(request.url, {
            mode: "no-cors",
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });

      return fetch(outbound)
        .then(function (response) {
          if (!response) return response;
          var trim = function () {
            return trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES);
          };

          if (response.type === "opaque") {
            safePut(cache, request, response.clone())
              .then(trim)
              .catch(function () {});
            return response;
          }

          // A readable response we can judge: a real picture, not an error.
          if (!response.ok) return response;
          response
            .clone()
            .blob()
            .then(function (blob) {
              if (blob.size < MIN_IMAGE_BYTES) return;
              return safePut(cache, request, new Response(blob)).then(trim);
            })
            .catch(function () {});
          return response;
        })
        .catch(function () {
          return Response.error();
        });
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

/* Content-addressed data: river day files, the story groups and the logo map
   are requested with ?v=<hash of the file>. An exact hit is therefore current
   - there is nothing to revalidate - and a day that changed arrives under a
   new URL. Storing it drops the superseded version of the same path. */
function cacheFirstVersioned(request) {
  return caches.open(DATA_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            putAssetFresh(cache, request, response.clone())
              .then(function () {
                return trimCache(DATA_CACHE, MAX_DATA_ENTRIES);
              })
              .catch(function () {});
          }
          return response;
        })
        .catch(function () {
          // Offline and never seen this version: an older one beats nothing.
          return cache
            .match(request, { ignoreSearch: true })
            .then(function (any) {
              return any || Response.error();
            });
        });
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

  /* Pictures are handled wherever they live - this is the one route that
     deliberately leaves our own origin, and it has to be tested before the
     origin check below rejects everything else. `destination` is what the
     browser itself decided the request was for, which is more reliable than
     matching file extensions on CDN URLs that rarely have one. */
  if (request.destination === "image") {
    event.respondWith(cacheFirstImage(request));
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

  if (url.searchParams.has("v")) {
    event.respondWith(cacheFirstVersioned(request));
    return;
  }

  event.respondWith(networkFirst(request, DATA_CACHE));
});

self.addEventListener("message", function (event) {
  if (event.data === "lb-skip-waiting") self.skipWaiting();
});
