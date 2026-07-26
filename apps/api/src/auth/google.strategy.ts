import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile, VerifyCallback } from 'passport-google-oauth20';
import { UsersService } from '../users/users.service';
import type { UserRecord } from '@scrapyard/shared';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Scrapyard runs strict domain-restricted Google SSO — see apps/api/.env.example.`,
    );
  }
  return value;
}

/**
 * The Google Workspace domains permitted to sign in — required, no default.
 * Accepts `cytactic.com` or `@cytactic.com`, and a comma-separated list.
 */
export function allowedDomains(): string[] {
  const domains = requiredEnv('ALLOWED_WORKSPACE_DOMAINS')
    .split(',')
    .map((value) => value.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

  if (domains.length === 0) {
    throw new Error(
      'ALLOWED_WORKSPACE_DOMAINS is set but empty. Scrapyard will not run an ' +
        'open sign-in — give it at least one domain, e.g. cytactic.com',
    );
  }
  return domains;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(private readonly users: UsersService) {
    const domains = allowedDomains();

    super({
      clientID: requiredEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requiredEnv('GOOGLE_CLIENT_SECRET'),
      callbackURL: requiredEnv('GOOGLE_CALLBACK_URL'),
      scope: ['openid', 'email', 'profile'],
      /*
       * With a single domain configured, ask Google to pre-filter the account
       * chooser to that tenant. Purely a UX nicety — never a security control,
       * which is why validate() re-checks the returned address regardless.
       */
      ...(domains.length === 1 ? { hd: domains[0] } : {}),
    });

    this.logger.log(
      `Google SSO restricted to: ${domains.map((d) => `@${d}`).join(', ')}`,
    );
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email) throw new ForbiddenException('Google account has no email address');

      /*
       * `verified` arrives as a boolean or the string 'true'/'false' depending
       * on the granted scope. Fail *closed*: require an explicit affirmative
       * rather than merely rejecting an explicit negative, so an absent field
       * can't wave an unverified address through.
       */
      const verified = profile.emails?.[0]?.verified as boolean | string | undefined;
      if (verified !== true && verified !== 'true') {
        throw new ForbiddenException(
          'Google did not confirm this email address is verified',
        );
      }

      /*
       * The real gate: the domain of the OAuth-verified address must be on the
       * allowlist. The `hd` parameter above is only a hint to Google's account
       * chooser and is trivially bypassable, so this check is what enforces it.
       */
      const domain = email.split('@')[1] ?? '';
      const permitted = allowedDomains();

      if (!permitted.includes(domain)) {
        this.logger.warn(`Rejected sign-in from ${email} (domain not allowed)`);
        throw new ForbiddenException(
          `Only ${permitted.map((d) => `@${d}`).join(' / ')} accounts can access Scrapyard`,
        );
      }

      const user: UserRecord = await this.users.upsertFromGoogle({
        googleId: profile.id,
        email,
        fullName: profile.displayName || email.split('@')[0],
        avatarUrl: profile.photos?.[0]?.value ?? '',
      });

      done(null, user);
    } catch (error) {
      done(error as Error, undefined);
    }
  }
}
