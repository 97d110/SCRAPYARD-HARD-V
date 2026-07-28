import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { IncomingHttpHeaders } from 'http';
import { UsersService } from '../users/users.service';
import { JwtPayload, SESSION_COOKIE } from '../auth/jwt.strategy';

/**
 * Reads the session outside Nest's guard pipeline.
 *
 * The guards work on controller routes, but two things that aren't controller
 * routes still have to answer "is this request authenticated?":
 *
 *  - the SPA, served by plain Express middleware, before it hands over a single
 *    byte of the bundle (see serve-spa.ts);
 *  - the WebSocket upgrade at /api/live, which Express never sees at all
 *    (see live.gateway.ts).
 *
 * Both work from the raw request headers, so that's what this reads — not
 * `request.cookies`, which only exists once cookie-parser has run and therefore
 * is always empty on an upgrade. It intentionally matches
 * JwtStrategy.validate(): verify the token, then confirm the racer still exists
 * in the database, so a deleted account can't keep browsing or stay subscribed.
 */
@Injectable()
export class SessionReader {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  /**
   * Resolve a request's session to the racer's id, or null if there isn't a
   * valid one. Returning the id rather than a boolean is what lets the socket
   * layer log and tag a connection without verifying the token twice.
   */
  async authenticate(headers: IncomingHttpHeaders): Promise<string | null> {
    const token = this.extractToken(headers);
    if (!token) return null;

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      if (!payload?.sub) return null;
      return (await this.users.findRaw(payload.sub)) ? payload.sub : null;
    } catch {
      // Expired, tampered with, or signed by a different secret.
      return null;
    }
  }

  async isAuthenticated(headers: IncomingHttpHeaders): Promise<boolean> {
    return (await this.authenticate(headers)) !== null;
  }

  private extractToken(headers: IncomingHttpHeaders): string | null {
    const cookie = this.readCookie(headers.cookie, SESSION_COOKIE);
    if (cookie) return cookie;

    const header = headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);

    return null;
  }

  /**
   * One cookie out of a raw `Cookie` header.
   *
   * Hand-rolled rather than reaching for cookie-parser's parser: this has to
   * work on an upgrade request, where no middleware has run, and the value we
   * want is a JWT — `[A-Za-z0-9._-]` and nothing else, so there is no encoding
   * subtlety to get wrong.
   */
  private readCookie(header: string | undefined, name: string): string | null {
    if (!header) return null;

    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=');
      if (separator === -1) continue;
      if (pair.slice(0, separator).trim() !== name) continue;
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }

    return null;
  }
}
