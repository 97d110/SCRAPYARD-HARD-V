/*
 * Scrapyard service worker — just enough to be installable and pleasant offline.
 *
 * Strategy, deliberately conservative:
 *   - /api/* and anything non-GET: never touched. Scores must always be live,
 *     and caching a mutation would be a bug.
 *   - navigations (opening a page): network-first, falling back to the cached
 *     app shell so a flaky connection still opens the app instead of the
 *     browser's dinosaur.
 *   - static assets (hashed JS/CSS, icons, the Lottie): stale-while-revalidate
 *     — instant from cache, refreshed in the background.
 *
 * Bump CACHE to invalidate everything on the next deploy.
 */
const CACHE = 'scrapyard-v1';
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/arthur.svg', '/icons/arthur-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle our own origin, GET only, and never the API.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Page loads: try the network, fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Static assets: serve cached immediately, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
