import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module';
import { mountLoginAssets, mountSpa } from './web/serve-spa';

/**
 * Build and configure the application, stopping short of listening.
 *
 * Split out of `main.ts` because there are now two ways in and they disagree
 * about exactly one thing. Locally the process owns its port and calls
 * `listen()`. On Vercel the whole app is a single function: the platform owns
 * the socket, hands us requests, and `listen()` is never called at all. Every
 * other piece of setup — parsers, prefix, guards, gate — is identical, and
 * keeping it in one place is what stops the two from drifting.
 *
 * The Express instance is a parameter so the serverless entrypoint can create
 * it first and hand requests to it while Nest is still starting up. See
 * `server.js` at the repo root.
 */
export async function createApp(
  instance: express.Express = express(),
): Promise<NestExpressApplication> {
  const logger = new Logger('Scrapyard');

  // We supply our own body parser because profile avatars may be posted as
  // inline data URLs, which blow past Express's default 100kb limit.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new ExpressAdapter(instance),
    { bodyParser: false },
  );

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
   * Behind a TLS terminator (Vercel, Fly, Railway, Cloud Run, an ALB) the hop to
   * this process is plain HTTP. Trusting the forwarding headers is what makes
   * request.protocol and request.ip reflect what the browser actually did.
   *
   * Not cosmetic: `auth.controller.ts` builds the post-login redirect target
   * from `request.protocol`, so without this the browser is sent back to an
   * http:// URL after signing in.
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
     * rather than passed through. Every value arrives as a string from a
     * platform's environment config.
     */
    const value: boolean | number | string =
      trustProxy === 'true' ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy;
    app.set('trust proxy', value);
    logger.log(`Trusting proxy headers: ${trustProxy}`);
  }

  /*
   * CORS is only meaningful when the app is served from a *different* origin
   * than this API. In the deployed shape it isn't — Nest serves the bundle
   * itself — so leaving WEB_ORIGIN empty disables cross-origin access entirely
   * rather than quietly allowing a stale localhost:5173.
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

  await app.init();

  return app;
}
