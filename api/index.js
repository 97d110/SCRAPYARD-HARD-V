/**
 * The Vercel entrypoint.
 *
 * Every request the project receives is rewritten to this one function (see
 * `vercel.json`), which is the shape this app already has — one origin serving
 * the API, the login page and the session-gated bundle. Express does the
 * routing inside, exactly as it does when the app runs as its own process.
 *
 * ── Why this file is JavaScript ─────────────────────────────────────────────
 *
 * It has to be. Vercel compiles a TypeScript entrypoint with esbuild, and
 * esbuild cannot emit `emitDecoratorMetadata` — the constructor parameter types
 * Nest's dependency injection reads to know what to inject. A TS entrypoint
 * would build cleanly and then fail at runtime with every provider undefined.
 *
 * So: this stays plain CommonJS and requires the output of `tsc` from
 * `npm run build`. Nothing under `apps/api/src` is ever handed to esbuild.
 *
 * ── Why the app is built lazily ─────────────────────────────────────────────
 *
 * `NestFactory.create` is async, and a module's exports are not. Rather than
 * block the module body, we export an Express instance immediately and let the
 * first request wait on initialisation. The promise is cached, so concurrent
 * cold requests share one bootstrap instead of racing to build the DI graph
 * several times over, and a warm instance skips it entirely.
 */

const express = require('express');

/** The instance Nest attaches its routes and middleware to. */
const inner = express();

/** The bootstrap, started on first request and shared by every one after. */
let ready = null;

function start() {
  ready ??= require('../apps/api/dist/app.factory')
    .createApp(inner)
    .catch((error) => {
      /*
       * Clear the cache so the next request retries rather than every future
       * request inheriting one bad boot — a transient Atlas timeout during a
       * cold start should not poison the instance for its whole lifetime.
       */
      ready = null;
      throw error;
    });
  return ready;
}

const app = express();

app.use((request, response, next) => {
  start().then(() => next(), next);
});

app.use(inner);

module.exports = app;
