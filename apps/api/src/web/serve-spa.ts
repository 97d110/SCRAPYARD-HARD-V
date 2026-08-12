import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync, statSync } from 'fs';
import * as path from 'path';
import { NextFunction, Request, Response } from 'express';
import { SessionReader } from './session-reader.service';
import { LOGIN_ASSETS_ROUTE, loginAssetsDir } from './login-background';

/**
 * ── Why this file no longer uses express.static ─────────────────────────────
 *
 * Vercel does not serve files through `express.static`. A deployed backend is
 * bundled by tracing `require`, which reaches modules but never an asset
 * directory, so the handler ends up looking at a filesystem that doesn't
 * contain the bundle. (`vercel.json` names the directory under `includeFiles`
 * to put the files *in* the deployment; this is about reading them once
 * they're there.)
 *
 * `response.sendFile` is the replacement, and it is the same machinery
 * underneath — Express's own `send`, so Range requests, ETags, conditional
 * 304s and content-type detection all behave exactly as they did. What changes
 * is that the path is resolved here, explicitly, instead of inside a middleware
 * that scans a directory it was handed.
 */

/**
 * Resolve a URL path to a file inside `root`, or null if it escapes.
 *
 * The guard is the point. `express.static` refused traversal on our behalf;
 * doing the resolution by hand means doing that by hand too, and `..` segments
 * are only half of it — a URL-encoded `%2e%2e` decodes into one *after* any
 * naive check on the raw string, which is why the check happens on the fully
 * resolved absolute path rather than on the input.
 */
function resolveWithin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A malformed escape sequence is not a file we have.
    return null;
  }

  if (decoded.includes('\0')) return null;

  const candidate = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;

  return candidate;
}

/** Send `file` if it is a readable regular file; otherwise fall through. */
function sendIfFile(
  response: Response,
  next: NextFunction,
  file: string,
  headers?: Record<string, string>,
): void {
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return next();

  response.sendFile(file, { headers, acceptRanges: true, dotfiles: 'deny' }, (error) => {
    // A client that hung up mid-transfer is not an error worth propagating, and
    // the headers are already sent so nothing can be done about it anyway.
    if (error && !response.headersSent) next(error);
  });
}

/**
 * Serves the login page's own media (background video, poster).
 *
 * Must be mounted *before* the SPA session gate: these files are part of the
 * wall itself, so requiring a session to fetch them would mean the login page
 * could never render its own background.
 */
export function mountLoginAssets(app: NestExpressApplication): void {
  const dir = loginAssetsDir();
  if (!existsSync(dir)) return;

  app.use(LOGIN_ASSETS_ROUTE, (request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();

    const file = resolveWithin(dir, request.path);
    if (!file) return next();

    // Video files are large and rarely change; let the browser keep them.
    sendIfFile(response, next, file, { 'Cache-Control': 'public, max-age=604800' });
  });

  new Logger('WebApp').log(`Serving login assets from ${dir}`);
}

/**
 * Serves the built React app — but only to requests that already hold a valid
 * session.
 *
 * This is the actual point of splitting login out of the SPA. An anonymous
 * visitor is redirected to `/login` before Express ever reaches the static
 * handler, so they receive neither `index.html` nor the JavaScript bundle. The
 * client-side route guard becomes a convenience rather than the boundary.
 *
 * Paths that stay open:
 *   /api/*         — has its own guards, and /api/auth/* must work pre-session
 *   /login         — the wall itself
 *   /login-assets  — the wall's background media
 *   /health        — not a real route (it lives at /api/health), but listing it
 *                    means a misconfigured probe gets an honest 404 instead of
 *                    a 302 to the login page, which reads as "up" to some checks
 *   /favicon.ico   — browsers request it unprompted; a redirect is just noise
 */
export function mountSpa(app: NestExpressApplication): void {
  const logger = new Logger('WebApp');

  /*
   * Where the built bundle is, most specific first.
   *
   * The `process.cwd()` entry is the one that matters on Vercel. Bundling
   * relocates the compiled output, so walking up from `__dirname` to find a
   * sibling directory stops being reliable — but the function runs with its
   * working directory at the deployment root, and `includeFiles` preserves the
   * repo-relative layout underneath it, so this path holds. WEB_DIST_DIR stays
   * as the explicit override for anything that does neither.
   */
  const candidates = [
    process.env.WEB_DIST_DIR,
    path.resolve(process.cwd(), 'apps', 'web', 'dist'),
    path.resolve(__dirname, '..', '..', '..', 'web', 'dist'),
    path.resolve(__dirname, '..', '..', 'public'),
  ]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => path.resolve(candidate));

  const webDist = candidates.find((candidate) => existsSync(path.join(candidate, 'index.html')));

  if (!webDist) {
    logger.log(
      'No built web bundle found — serving the API and /login only. ' +
        'In development the Vite dev server hosts the app and proxies here.',
    );
    return;
  }

  const indexHtml = path.join(webDist, 'index.html');

  const isOpenPath = (url: string): boolean =>
    url.startsWith('/api') ||
    url === '/login' ||
    url.startsWith('/login?') ||
    url.startsWith(LOGIN_ASSETS_ROUTE) ||
    url === '/health' ||
    url === '/favicon.ico' ||
    // PWA assets must resolve before the session gate: the manifest and icons
    // drive the install prompt, and the service worker registers at the root
    // scope — all of which the browser fetches without carrying our cookie.
    url === '/manifest.webmanifest' ||
    url === '/sw.js' ||
    url.startsWith('/icons/');

  const session = app.get(SessionReader);

  // 1. The gate. Runs before the file handler, so it decides whether the
  //    bundle is delivered at all.
  app.use(async (request: Request, response: Response, next: NextFunction) => {
    if (isOpenPath(request.originalUrl)) return next();

    if (await session.isAuthenticated(request.headers)) return next();

    /*
     * A refusal is as per-user as an acceptance. Saying so explicitly keeps a
     * shared cache from holding on to either one and replaying it at somebody
     * in the opposite state — a cached 401 locking out a signed-in racer is the
     * same class of bug as a cached bundle leaking to an anonymous one.
     */
    response.setHeader('Cache-Control', 'private, no-store');

    // Asset requests (JS/CSS/map) get a bare 401 rather than an HTML redirect —
    // redirecting a script tag to a login page just yields a confusing parse
    // error in the console.
    if (/\.(js|mjs|css|map|json|png|jpe?g|svg|webp|ico|woff2?)$/i.test(request.path)) {
      response.status(401).type('text/plain').send('Not authenticated');
      return;
    }

    response.redirect(302, '/login');
  });

  /*
   * 2. The bundle.
   *
   * ── `private` is doing security work here, not performance work ───────────
   *
   * Everything this handler serves has already passed the session gate above,
   * which means every response is the answer to *who asked*. A CDN sits in
   * front of this in the deployed shape, and a shared cache does not know that:
   * `public` invites it to store one racer's authenticated response and hand it
   * to the next anonymous request without ever consulting the function.
   *
   * That is not theoretical — it is exactly what happened. The first deploy
   * used `public, max-age=31536000, immutable` (correct on a host with no CDN
   * in front, which is where this code came from) and the JS bundle started
   * returning 200 to anonymous callers with `x-vercel-cache: HIT`, with the
   * gate never running. `private` forbids shared caches while still letting the
   * *browser* keep the file for a year, so the caching intent survives intact.
   *
   * It is applied to every gated response rather than only the hashed assets:
   * anything served from behind the gate is per-user by definition, and relying
   * on "no Cache-Control means no caching" is a weaker guarantee than saying so.
   */
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();

    const file = resolveWithin(webDist, request.path);
    if (!file || file === webDist) return next();

    // Never hand out index.html from here — the SPA fallback below owns it, and
    // it is the one file whose caching must not be left to chance.
    if (file === indexHtml) return next();

    // Hashed filenames change on every build, so a year is safe — but only in
    // the browser that fetched it.
    const isHashedAsset = file.startsWith(path.join(webDist, 'assets') + path.sep);

    sendIfFile(response, next, file, {
      'Cache-Control': isHashedAsset
        ? 'private, max-age=31536000, immutable'
        : 'private, no-cache',
    });
  });

  // 3. SPA fallback — client-side routes like /racers and /admin must all
  //    resolve to index.html. Only GET; anything else is a genuine 404.
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    if (isOpenPath(request.originalUrl)) return next();

    response.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    response.sendFile(indexHtml);
  });

  logger.log(`Serving the web app from ${webDist} (session required)`);
}
