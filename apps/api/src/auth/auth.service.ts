import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CookieOptions, Response } from 'express';
import type { UserRecord } from '@scrapyard/shared';
import { JwtPayload, SESSION_COOKIE } from './jwt.strategy';

const SESSION_TTL_DAYS = 30;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    if (!this.secureCookies() && this.config.get('NODE_ENV') !== 'test') {
      this.logger.warn(
        'Session cookies are being issued without the Secure flag. ' +
          'Set NODE_ENV=production (or COOKIE_SECURE=true) when serving over HTTPS.',
      );
    }
  }

  /**
   * Secure defaults to on in production. COOKIE_SECURE is an explicit override
   * for deployments that terminate TLS upstream but don't set NODE_ENV.
   */
  private secureCookies(): boolean {
    const explicit = this.config.get<string>('COOKIE_SECURE');
    if (explicit !== undefined && explicit !== '') return explicit === 'true';
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  private cookieOptions(): CookieOptions {
    const domain = this.config.get<string>('COOKIE_DOMAIN');
    return {
      httpOnly: true,
      secure: this.secureCookies(),
      // 'lax' is required for the OAuth redirect back from Google to carry the cookie.
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
      ...(domain ? { domain } : {}),
    };
  }

  issueSession(response: Response, user: UserRecord): string {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    const token = this.jwt.sign(payload, { expiresIn: `${SESSION_TTL_DAYS}d` });
    response.cookie(SESSION_COOKIE, token, this.cookieOptions());
    return token;
  }

  clearSession(response: Response): void {
    const { maxAge: _maxAge, ...options } = this.cookieOptions();
    response.clearCookie(SESSION_COOKIE, options);
  }
}
