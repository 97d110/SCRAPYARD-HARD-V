import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { UsersService } from '../users/users.service';
import type { PublicUser, UserRole } from '@scrapyard/shared';

export const SESSION_COOKIE = 'scrapyard_session';

const DEV_SECRET = 'scrapyard-dev-secret-change-me';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

/**
 * Single source of truth for the signing secret, resolved through ConfigService
 * so it is read after .env has loaded. Both JwtModule and this strategy call
 * it, which is what guarantees sign and verify agree.
 */
export function jwtSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_SECRET');
  if (!secret) {
    new Logger('AuthConfig').warn(
      'JWT_SECRET is not set — falling back to a well-known development secret. ' +
        'Set it in apps/api/.env before deploying.',
    );
    return DEV_SECRET;
  }
  return secret;
}

/** Session lives in an httpOnly cookie; Bearer is accepted for scripts/tests. */
const fromCookie = (req: Request): string | null =>
  (req.cookies?.[SESSION_COOKIE] as string | undefined) ?? null;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly users: UsersService,
    config: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        fromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: jwtSecret(config),
      ignoreExpiration: false,
    });
  }

  /** Re-read the user file so a role change or deletion takes effect at once. */
  async validate(payload: JwtPayload): Promise<PublicUser> {
    const user = await this.users.findRaw(payload.sub);
    if (!user) throw new UnauthorizedException('Session refers to a racer that no longer exists');
    return this.users.toPublic(user);
  }
}
