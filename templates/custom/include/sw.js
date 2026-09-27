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
 *   pictures    -> cache first, on any origin, capped and quota-safe
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
var VERSION = "v3";
var SHELL_CACHE = VERSION + "-shell";
var DATA_CACHE = VERSION + "-data";
var IMAGE_CACHE = VERSION + "-img";

/* The feed set is 31 feeds plus 29 archives, so the old cap of 60 sat exactly
   on the boundary: one more source and every build would evict a feed the
   reader had already loaded. This leaves room for the archives to grow. */
var MAX_DATA_ENTRIES = 200;
var MAX_IMAGE_ENTRIES = 160;

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
 * headers, `ok` false - which is fine to cache and hand to an <img>, and
 * impossible to validate. A 404 page and a photograph are indistinguishable,
 * so the only sanity check available is size: anything under a favicon's
 * worth of bytes is not a news picture and is not worth an entry. */
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
          // A same-origin response we can judge; an opaque one we cannot.
          if (sameOrigin && !response.ok) return response;

          var copy = response.clone();
          copy
            .blob()
            .then(function (blob) {
              if (blob.size < MIN_IMAGE_BYTES) return;
              return safePut(cache, request, new Response(blob)).then(
                function () {
                  return trimCache(IMAGE_CACHE, MAX_IMAGE_ENTRIES);
                },
              );
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

  event.respondWith(networkFirst(request, DATA_CACHE));
});

/* The worker cannot discover the feed files on its own: their names are
   content hashes that only the page knows, from window.feeds. So the page
   hands the list over once it has loaded, and anything not already cached is
   fetched in the background.

   Without this, what survives going offline is only what the reader happened
   to scroll past - the SPA fetches feeds lazily, so a quick look at the top
   of the river leaves most of it uncached. */
function precacheFeeds(urls) {
  if (!urls || !urls.length) return Promise.resolve();
  return caches.open(DATA_CACHE).then(function (cache) {
    return urls
      .reduce(function (chain, url) {
        return chain.then(function () {
          return cache.match(url).then(function (hit) {
            if (hit) return;
            return fetch(url, { cache: "no-cache" })
              .then(function (response) {
                if (response && response.ok)
                  return safePut(cache, url, response.clone());
              })
              .catch(function () {});
          });
        });
        // Sequentially, not in parallel: this runs behind a reader who is
        // already looking at the page, and must not compete with the
        // pictures they are actually scrolling towards.
      }, Promise.resolve())
      .then(function () {
        return trimCache(DATA_CACHE, MAX_DATA_ENTRIES);
      });
  });
}

self.addEventListener("message", function (event) {
  var data = event.data;
  if (data === "lb-skip-waiting") {
    self.skipWaiting();
    return;
  }
  if (data && data.type === "lb-cache-feeds") {
    event.waitUntil(precacheFeeds(data.urls));
  }
});
