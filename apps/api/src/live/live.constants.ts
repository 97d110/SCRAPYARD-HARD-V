/**
 * Where the socket lives, and how a tab identifies itself.
 *
 * The path sits *under* /api on purpose. Three separate things already treat
 * `/api/*` as "not the app", and all three need to keep doing so:
 *
 *   - serve-spa.ts lets it past the session gate (the gateway does its own
 *     check on the upgrade, and a 302 to /login is meaningless to a socket);
 *   - the service worker never touches it, so it can't be cached or replayed;
 *   - Vite's dev proxy forwards it to Nest, which is what keeps the browser
 *     same-origin in development and therefore keeps sending the cookie.
 */
export const LIVE_PATH = '/api/live';

/**
 * Set by the client on every mutating request and echoed back on the resulting
 * event as `origin`, so the tab that caused a change can ignore its own echo —
 * it already applied the response. Per tab, not per user: somebody with the
 * wall display open and their phone in hand must still see the phone's race
 * land on the wall.
 */
export const CLIENT_ID_HEADER = 'x-scrapyard-client';
