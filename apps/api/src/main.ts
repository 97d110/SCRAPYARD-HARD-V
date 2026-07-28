import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module';
import { mountLoginAssets, mountSpa } from './web/serve-spa';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Scrapyard');

  // We supply our own body parser because profile avatars may be posted as
  // inline data URLs, which blow past Express's default 100kb limit.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());

  /*
   * Everything is under /api except the login page, which is a user-facing
   * document rather than an endpoint.
   */
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'login', method: RequestMethod.GET }],
  });

  /*
   * Login page assets (the background video, its poster) must be reachable
   * *before* the session gate — they're part of the wall itself.
   */
  mountLoginAssets(app);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  /*
   * Behind a TLS terminator (Fly, Render, Railway, Cloud Run, an ALB) the hop to
   * this process is plain HTTP. Trusting the forwarding headers is what makes
   * request.protocol and request.ip reflect what the browser actually did.
   *
   * Off by default: blindly trusting X-Forwarded-* when nothing sits in front
   * would let a client spoof its own IP.
   */
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy && trustProxy !== 'false') {
    /*
     * Three accepted shapes, and the order matters. Express hands any *other*
     * string to proxy-addr, which parses it as a list of IPs or subnets and
     * throws on anything else — so 'true' must be converted to a real boolean
     * rather than passed through. Render sets this from render.yaml, where
     * every value arrives as a string.
     */
    const value: boolean | number | string =
      trustProxy === 'true' ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy;
    app.set('trust proxy', value);
    logger.log(`Trusting proxy headers: ${trustProxy}`);
  }

  /*
   * CORS is only meaningful when the app is served from a *different* origin
   * than this API. In the single-container deployment it isn't — Nest serves the
   * bundle itself — so leaving WEB_ORIGIN empty disables cross-origin access
   * entirely rather than quietly allowing a stale localhost:5173.
   */
  const origins = (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      credentials: true,
      // Lets a cross-origin fetch() read the suggested zip filename back off the
      // database-export response.
      exposedHeaders: ['X-Scrapyard-Filename'],
    });
  }

  /*
   * The built React app, gated on a valid session. Mounted last so the API
   * routes and /login are matched first. When no bundle is present (development)
   * this is a no-op and Vite hosts the app instead.
   */
  mountSpa(app);

  const port = Number(process.env.PORT ?? 3000);
  // Bind explicitly to all interfaces. This is already Nest's default, but
  // stating it means a container can never end up loopback-only and unreachable.
  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on http://localhost:${port}/api`);
  logger.log(`Login page at http://localhost:${port}/login`);
  logger.log(
    origins.length > 0
      ? `CORS origins: ${origins.join(', ')}`
      : 'CORS disabled — same-origin only (WEB_ORIGIN is unset)',
  );

  /*
   * Free Render instances have no shell, so the only way to inspect a
   * deployment is the log stream. Run the connectivity checks at boot and put
   * the verdict there.
   *
   * Deliberately after listen() and never awaited: a failing check must not
   * stop the service from serving /login, which is where the operator will be
   * looking. PREFLIGHT=off silences it.
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
