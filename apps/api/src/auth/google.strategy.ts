import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile, VerifyCallback } from 'passport-google-oauth20';
import { UsersService } from '../users/users.service';
import { allowedDomains, hostedDomainHint, isAllowedEmail, requiredEnv } from '../common/access';
import type { UserRecord } from '@scrapyard/shared';

/*
 * Re-exported for the handful of call sites that already import it from here.
 * The definition lives in common/access.ts so the users service can share it
 * without closing an import cycle back through this file.
 */
export { allowedDomains };

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(private readonly users: UsersService) {
    const hint = hostedDomainHint();

    super({
      clientID: requiredEnv('GOOGLE_CLIENT_ID'),
      clientSecret: requiredEnv('GOOGLE_CLIENT_SECRET'),
      callbackURL: requiredEnv('GOOGLE_CALLBACK_URL'),
      scope: ['openid', 'email', 'profile'],
      /*
       * With a single plain Workspace domain configured, ask Google to
       * pre-filter the account chooser to that tenant. Purely a UX nicety —
       * never a security control, and meaningless for glob/email allowlists,
       * which is why validate() re-checks the returned address regardless.
       */
      ...(hint ? { hd: hint } : {}),
    });

    this.logger.log(`Google SSO restricted to: ${allowedDomains().map((d) => `@${d}`).join(', ')}`);
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
       * The real gate: the OAuth-verified address must match the allowlist
       * patterns. The `hd` parameter above is only a hint to Google's account
       * chooser and is trivially bypassable, so this check is what enforces it.
       */
      if (!isAllowedEmail(email)) {
        this.logger.warn(`Rejected sign-in from ${email} (not on the allowlist)`);
        throw new ForbiddenException(
          `Only ${allowedDomains().map((d) => `@${d}`).join(' / ')} accounts can access Scrapyard`,
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
