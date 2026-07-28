import { Controller, Get, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { allowedDomains } from './google.strategy';
import { CurrentUser, JwtAuthGuard } from './guards';
import { OAuthExceptionFilter } from './oauth-exception.filter';
import { LiveGateway } from '../live/live.gateway';
import type { PublicUser, UserRecord } from '@scrapyard/shared';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly live: LiveGateway,
  ) {}

  /**
   * Where to send a successfully signed-in browser.
   *
   * Three deployment shapes, one rule: use WEB_ORIGIN only when the app is
   * genuinely on a *different* origin than this API.
   *
   *  - dev            API on :3000, Vite on :5173  → absolute, to :5173
   *  - single service API serves the bundle itself  → relative
   *  - split hosts    static host elsewhere         → absolute, to WEB_ORIGIN
   *
   * Returning '' for the same-origin cases keeps the redirect relative, which
   * survives being put behind a proxy or a different public hostname.
   */
  private appRoot(request: Request): string {
    const configured = (this.config.get<string>('WEB_ORIGIN') ?? '').split(',')[0].trim();
    if (!configured) return '';

    const ownOrigin = `${request.protocol}://${request.get('host') ?? ''}`;
    return configured.replace(/\/$/, '') === ownOrigin ? '' : configured.replace(/\/$/, '');
  }

  /** Kick off the Google consent screen. */
  @Get('google')
  @UseGuards(AuthGuard('google'))
  @UseFilters(OAuthExceptionFilter)
  startGoogle(): void {
    // Passport issues the redirect; nothing to do here.
  }

  /**
   * Google redirects back here. Passport has already validated the token and
   * enforced the Workspace-domain allowlist, so at this point we just mint the
   * session cookie and bounce to the app.
   *
   * The filter turns a rejection (wrong domain, unverified address) into a
   * redirect carrying the reason, rather than a raw JSON 403 in the browser.
   */
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @UseFilters(OAuthExceptionFilter)
  async googleCallback(
    @Req() request: Request & { user: UserRecord },
    @Res() response: Response,
  ): Promise<void> {
    this.auth.issueSession(response, request.user);

    /*
     * A sign-in is a roster change more often than it looks. upsertFromGoogle
     * may have created a racer, claimed an admin-created seat (so `claimed`
     * flips and a real avatar appears where a blank face was), reconciled the
     * role against ADMIN_EMAILS, or refreshed the Google-sourced name. No
     * `origin`: this arrives as a browser redirect from Google, not a fetch, so
     * there is no client id to carry — and the newly signed-in tab is about to
     * load everything from scratch anyway.
     */
    this.live.broadcast({ type: 'roster:changed', reason: 'login', userId: request.user.id });

    response.redirect(`${this.appRoot(request)}/?welcome=1`);
  }

  /** The current session's racer, or 401 if there isn't one. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: PublicUser): Promise<PublicUser> {
    return user;
  }

  @Post('logout')
  logout(@Res() response: Response): void {
    this.auth.clearSession(response);
    response.status(204).send();
  }

  /**
   * Advertises how login works so the client can render the right button and
   * error copy without hardcoding the tenant.
   */
  @Get('config')
  loginConfig(): { provider: 'google'; allowedDomains: string[]; loginUrl: string } {
    return {
      provider: 'google',
      allowedDomains: allowedDomains(),
      loginUrl: '/api/auth/google',
    };
  }
}
