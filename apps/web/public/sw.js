/*
 * Scrapyard service worker — just enough to be installable and pleasant offline.
 *
 * Strategy, deliberately conservative:
 *   - /api/* and anything non-GET: never touched. Scores must always be live,
 *     caching a mutation would be a bug, and the live channel's WebSocket lives
 *     under /api too.
 *   - /login and its media: never touched either. That's the server's own page,
 *     it must never be served from cache to somebody who has since signed in,
 *     and its background video is far too big to want a copy of.
 *   - navigations (opening a page): network-first, falling back to the cached
 *     app shell so a flaky connection still opens the app instead of the
 *     browser's dinosaur.
 *   - static assets (hashed JS/CSS, icons, the Lottie, the emblem):
 *     stale-while-revalidate — instant from cache, refreshed in the background.
 *
 * Bump CACHE to throw everything away on the next deploy. It is rarely
 * necessary: the bundle's filenames are content-hashed, so a new build asks for
 * URLs that were never in here, and navigations go to the network first.
 */
const CACHE = 'scrapyard-v3';

/** The one entry that isn't keyed by its own URL: the app shell. */
const SHELL_URL = '/';

/*
 * Warmed at install so the first offline launch has something to open.
 *
 * Added one at a time rather than with `cache.addAll`, which is atomic: a single
 * missing file rejects the whole install, the worker never activates, and the
 * app silently stops being installable at all. (That is not hypothetical — this
 * list used to name an icon that didn't exist.) A shell that's partly warm is
 * strictly better than no service worker.
 */
const APP_SHELL = [SHELL_URL, '/manifest.webmanifest', '/icons/arthur-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
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

/** Paths the worker must stay out of entirely. */
function isOffLimits(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/login' ||
    url.pathname.startsWith('/login-assets/')
  );
}

/**
 * Is this response actually the app shell?
 *
 * The session is the case that matters. With an expired one the server answers a
 * navigation with a 302 to /login, and what comes back is the login wall — which
 * stored as the shell would mean the next offline launch opens a login page
 * nobody can complete. A navigation request carries `redirect: 'manual'`, so
 * that arrives here as an opaque redirect: status 0, and therefore not `ok`.
 */
function isShell(response) {
  return response.ok && !response.redirected;
}

/**
 * Is this response worth keeping under the URL that was asked for?
 *
 * The HTML check is the load-bearing one, and it is not hypothetical: a plain
 * `fetch('/')` is not a *navigation*, so it lands in the asset branch below —
 * and with the session gone that fetch follows its 302 and comes back as a
 * perfectly `ok` login page, which then overwrites the app shell. The same
 * applies to any unknown path, which the server answers with index.html via the
 * SPA fallback.
 *
 * Nothing this app legitimately caches here is a document: the bundle, the CSS,
 * the icons, the Lottie and the emblem are all assets. So "came back as HTML"
 * means "not what was asked for", and the right move is to pass it through
 * without keeping a copy.
 */
function isCacheableAsset(response) {
  if (!response.ok || response.redirected) return false;
  return !(response.headers.get('Content-Type') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle our own origin, GET only, and never the API or the login wall.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (isOffLimits(url)) return;

  // Page loads: try the network, fall back to the cached shell offline. Every
  // in-app route resolves to the same index.html, so they all refresh it.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isShell(response)) {
            const copy = response.clone();
            caches
              .open(CACHE)
              .then((cache) => cache.put(SHELL_URL, copy))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(SHELL_URL).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Static assets: serve cached immediately, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (isCacheableAsset(response)) {
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
