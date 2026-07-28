import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { existsSync } from 'fs';
import * as path from 'path';
import { NextFunction, Request, Response } from 'express';
import { SessionReader } from './session-reader.service';
import { LOGIN_ASSETS_ROUTE, loginAssetsDir } from './login-background';

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

  app.use(
    LOGIN_ASSETS_ROUTE,
    express.static(dir, {
      index: false,
      // Video files are large and rarely change; let the browser keep them.
      maxAge: '7d',
      // Range requests matter for video seeking/streaming.
      acceptRanges: true,
      dotfiles: 'ignore',
    }),
  );

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

  // In the repo: apps/api/dist/web -> ../../../web/dist
  // In the Docker image: /app/dist/web -> /app/public
  const candidates = [
    process.env.WEB_DIST_DIR,
    path.resolve(__dirname, '..', '..', '..', 'web', 'dist'),
    path.resolve(__dirname, '..', '..', 'public'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const webDist = candidates.find((candidate) =>
    existsSync(path.join(candidate, 'index.html')),
  );

  if (!webDist) {
    logger.log(
      'No built web bundle found — serving the API and /login only. ' +
        'In development the Vite dev server hosts the app and proxies here.',
    );
    return;
  }

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

  // 1. The gate. Runs before the static handler, so it decides whether the
  //    bundle is delivered at all.
  app.use(async (request: Request, response: Response, next: NextFunction) => {
    if (isOpenPath(request.originalUrl)) return next();

    if (await session.isAuthenticated(request.headers)) return next();

    // Asset requests (JS/CSS/map) get a bare 401 rather than an HTML redirect —
    // redirecting a script tag to a login page just yields a confusing parse
    // error in the console.
    if (/\.(js|mjs|css|map|json|png|jpe?g|svg|webp|ico|woff2?)$/i.test(request.path)) {
      response.status(401).type('text/plain').send('Not authenticated');
      return;
    }

    response.redirect(302, '/login');
  });

  // 2. Hashed assets are immutable; index.html must never be cached or a deploy
  //    would keep serving the old bundle references.
  app.use(
    express.static(webDist, {
      index: false,
      setHeaders: (response, filePath) => {
        if (filePath.endsWith('index.html')) {
          response.setHeader('Cache-Control', 'no-store, must-revalidate');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  // 3. SPA fallback — client-side routes like /racers and /admin must all
  //    resolve to index.html. Only GET; anything else is a genuine 404.
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    if (isOpenPath(request.originalUrl)) return next();

    response.setHeader('Cache-Control', 'no-store, must-revalidate');
    response.sendFile(path.join(webDist, 'index.html'));
  });

  logger.log(`Serving the web app from ${webDist} (session required)`);
}
