import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { renderLoginPage } from './login-page';
import { resolveLoginBackground } from './login-background';
import { allowedDomains } from '../auth/google.strategy';
import { SessionReader } from './session-reader.service';

/**
 * `GET /login` — the only HTML an unauthenticated visitor is ever served.
 *
 * Mounted outside the `/api` prefix (see the `exclude` in main.ts) because it's
 * a user-facing page, not an endpoint.
 */
@Controller('login')
export class LoginController {
  constructor(private readonly session: SessionReader) {}

  @Get()
  async page(
    @Req() request: Request,
    @Res() response: Response,
    @Query('authError') authError?: string,
  ): Promise<void> {
    // Already signed in? No reason to show a login wall.
    if (await this.session.isAuthenticated(request)) {
      response.redirect('/');
      return;
    }

    // The login page is per-request (it may carry an error) and must never be
    // cached by a proxy, or a stale error could outlive the attempt.
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store, must-revalidate');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // The YouTube backdrop needs a referrer to serve the embed, so same-origin
    // alone is too strict here; this still withholds the path.
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    response.send(
      renderLoginPage({
        allowedDomains: allowedDomains(),
        // Cap the length so a crafted link can't stuff the page with text.
        error: authError ? authError.slice(0, 300) : undefined,
        loginUrl: '/api/auth/google',
        background: resolveLoginBackground(),
      }),
    );
  }
}
