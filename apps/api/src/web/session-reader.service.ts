import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { UsersService } from '../users/users.service';
import { JwtPayload, SESSION_COOKIE } from '../auth/jwt.strategy';

/**
 * Reads the session outside Nest's guard pipeline.
 *
 * The guards work on controller routes, but the SPA is served by plain Express
 * middleware — which still has to answer "is this request authenticated?"
 * before handing over a single byte of the bundle. This is that check, and it
 * intentionally matches JwtStrategy.validate(): verify the token, then confirm
 * the racer still exists on disk, so a deleted account can't keep browsing.
 */
@Injectable()
export class SessionReader {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async isAuthenticated(request: Request): Promise<boolean> {
    const token = this.extractToken(request);
    if (!token) return false;

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      if (!payload?.sub) return false;
      return (await this.users.findRaw(payload.sub)) !== null;
    } catch {
      // Expired, tampered with, or signed by a different secret.
      return false;
    }
  }

  private extractToken(request: Request): string | null {
    const cookie = (request.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ];
    if (cookie) return cookie;

    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);

    return null;
  }
}
