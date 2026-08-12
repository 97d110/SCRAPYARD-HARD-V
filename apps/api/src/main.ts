import { Logger } from '@nestjs/common';
import { createApp } from './app.factory';
import { LIVE_PATH } from './live/live.constants';

/**
 * Run Scrapyard as its own process, listening on a port.
 *
 * This is the local path — `npm run dev`, `npm start`, `npm run preview` — and
 * the one to use on any host that runs a container. The deployed shape on
 * Vercel does not come through here at all: the app is a function there, and
 * `server.js` at the repo root is its entrypoint. Everything the two have in
 * common lives in `createApp`.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Scrapyard');

  const app = await createApp();

  /*
   * Without this, Nest's onApplicationShutdown/onModuleDestroy hooks never run:
   * the process takes SIGTERM and exits with them unfired. MongoService closing
   * its client depends on it, so a restart doesn't leave Atlas holding a pool it
   * will only reap on its own schedule.
   */
  app.enableShutdownHooks();

  /*
   * ...and this is what lets that shutdown actually finish.
   *
   * Nest's hook awaits `app.close()`, which awaits `server.close()`, which by
   * design waits for every open connection to end. A browser sitting on the
   * leaderboard holds an idle keep-alive connection, so it waits: the process
   * hangs until the supervisor gives up and SIGKILLs it. Dropping the
   * connections ourselves is the missing half.
   *
   * This used to matter far more, when a live WebSocket per tab meant the wait
   * was unbounded rather than merely a keep-alive timeout. Polling removed that,
   * but a clean exit is still worth the four lines.
   *
   * Registered before enableShutdownHooks' own handler gets to close(), and
   * `once` so a second SIGTERM still falls through to the default behaviour.
   */
  const httpServer = app.getHttpServer();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.log(`${signal} received — closing connections`);
      httpServer.closeAllConnections();
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  // Bind explicitly to all interfaces. This is already Nest's default, but
  // stating it means a container can never end up loopback-only and unreachable.
  await app.listen(port, '0.0.0.0');

  const origins = (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  logger.log(`API listening on http://localhost:${port}/api`);
  logger.log(`Login page at http://localhost:${port}/login`);
  logger.log(`Live updates at http://localhost:${port}${LIVE_PATH}/events`);
  logger.log(
    origins.length > 0
      ? `CORS origins: ${origins.join(', ')}`
      : 'CORS disabled — same-origin only (WEB_ORIGIN is unset)',
  );

  /*
   * Connectivity checks at boot, with the verdict in the log stream.
   *
   * Deliberately after listen() and never awaited: a failing check must not
   * stop the service from serving /login, which is where the operator will be
   * looking. PREFLIGHT=off silences it — which is what the serverless
   * deployment does, since there it would open a second MongoClient on every
   * single cold start.
   */
  if (process.env.PREFLIGHT !== 'off') {
    void (async () => {
      try {
        const { runPreflight, formatReport } = await import('./diagnostics/preflight');
        const checks = await runPreflight();
        const report = `Preflight\n${formatReport(checks)}`;
        if (checks.some((check) => check.status === 'fail')) {
          logger.error(report);
        } else {
          logger.log(report);
        }
      } catch (error) {
        logger.warn(`Preflight could not run: ${error instanceof Error ? error.message : error}`);
      }
    })();
  }
}

void bootstrap();
