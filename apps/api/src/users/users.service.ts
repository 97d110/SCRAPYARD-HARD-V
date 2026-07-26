import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JsonStoreService } from '../database/json-store.service';
import { IndexService } from '../database/index.service';
import { ScoreboardBuilder } from '../database/scoreboard.builder';
import type { PublicUser, UserRecord, UserRole } from '@scrapyard/shared';

/** The 16 BlazeRush pilots, plus the Star Track ships. Pure flavour. */
export const RACERS = [
  'Arthur',
  'Turboboy',
  'Hotty',
  'Tailfin',
  'Old Rowdy',
  'Beast',
  'Pushback',
  'Arrow',
  'Predator',
  'Dipnoi',
  'DriftKing',
  'Rex',
  'Panzerflachbagger',
  'Dee',
  'Twins',
  'UFO',
  'Mr. Shnek',
] as const;

/** Neon accents a racer can pick, all tuned to sit on the dark backdrop. */
export const ACCENT_COLORS = [
  '#FF6A00',
  '#FFB020',
  '#00E5FF',
  '#FF2D95',
  '#B6FF3C',
  '#7C5CFF',
  '#FF3B30',
  '#00FFA3',
] as const;

export interface UpsertFromGoogleInput {
  googleId: string;
  email: string;
  fullName: string;
  avatarUrl: string;
}

export interface ProfilePatch {
  displayName?: string;
  avatarUrl?: string;
  tagline?: string;
  favoriteRacer?: string;
  accentColor?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly store: JsonStoreService,
    private readonly index: IndexService,
    private readonly boards: ScoreboardBuilder,
  ) {}

  private fileFor(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new BadRequestException('Malformed user id');
    }
    return `users/${id}.json`;
  }

  /** Emails granted the admin role, from ADMIN_EMAILS. */
  private adminEmails(): string[] {
    return (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Bring an existing racer's role in line with ADMIN_EMAILS at login.
   *
   * When the list is configured it is the single source of truth: listed emails
   * are promoted, unlisted ones demoted. That means hand-editing `role` in a
   * JSON file won't survive the next login — deliberate, so there's exactly one
   * place that decides who is an admin.
   *
   * When the list is empty we leave whatever role is on file alone, so a
   * first-racer bootstrap admin isn't demoted out of their own admin page.
   */
  private reconcileRole(user: UserRecord, email: string, admins: string[]): UserRole {
    if (admins.length === 0) return user.role;

    const shouldBeAdmin = admins.includes(email);
    if (shouldBeAdmin && user.role !== 'admin') {
      this.logger.log(`${email} promoted to admin (listed in ADMIN_EMAILS)`);
    } else if (!shouldBeAdmin && user.role === 'admin') {
      this.logger.warn(`${email} demoted to racer (not listed in ADMIN_EMAILS)`);
    }
    return shouldBeAdmin ? 'admin' : 'racer';
  }

  async findRaw(id: string): Promise<UserRecord | null> {
    return this.store.read<UserRecord>(this.fileFor(id));
  }

  async requireRaw(id: string): Promise<UserRecord> {
    const user = await this.findRaw(id);
    if (!user) throw new NotFoundException(`No racer with id ${id}`);
    return user;
  }

  async findAllRaw(): Promise<UserRecord[]> {
    return this.store.readAll<UserRecord>('users');
  }

  async findAll(): Promise<PublicUser[]> {
    const users = await this.findAllRaw();
    return users
      .map((user) => this.toPublic(user))
      .sort((a, b) => b.scores.allTime - a.scores.allTime || a.displayName.localeCompare(b.displayName));
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const target = email.trim().toLowerCase();
    const users = await this.findAllRaw();
    return users.find((user) => user.email === target) ?? null;
  }

  /**
   * Called on every successful Google login. Creates the racer's file on first
   * sight, otherwise refreshes the Google-sourced fields (name/picture) while
   * leaving anything the user has customised alone.
   */
  async upsertFromGoogle(input: UpsertFromGoogleInput): Promise<UserRecord> {
    return this.store.transaction(async () => {
      const email = input.email.trim().toLowerCase();
      const domain = email.split('@')[1] ?? '';
      const now = new Date().toISOString();

      const admins = this.adminEmails();
      const existing = await this.findRaw(input.googleId);

      if (existing) {
        const updated: UserRecord = {
          ...existing,
          email,
          domain,
          googleFullName: input.fullName || existing.googleFullName,
          googleAvatarUrl: input.avatarUrl || existing.googleAvatarUrl,
          // ADMIN_EMAILS is declarative — reconcile on every login, not just
          // at account creation. Otherwise adding yourself to the list after
          // you'd already signed in would never take effect.
          role: this.reconcileRole(existing, email, admins),
          lastLoginAt: now,
          updatedAt: now,
        };
        await this.store.write(this.fileFor(updated.id), updated);
        await this.index.rebuild();
        return updated;
      }

      /*
       * Admin assignment.
       *
       * ADMIN_EMAILS is the authoritative route, and it's order-independent:
       * whoever is listed becomes admin whenever they first sign in, even if
       * ten other racers got there first.
       *
       * The first-racer fallback only applies when ADMIN_EMAILS is unset, so a
       * fresh install isn't locked out of its own admin page. It warns loudly,
       * because "whoever signs in first wins" is not a policy you want to
       * discover by accident.
       */
      let role: UserRole = 'racer';

      if (admins.includes(email)) {
        role = 'admin';
        this.logger.log(`${email} granted admin (listed in ADMIN_EMAILS)`);
      } else if (admins.length === 0 && (await this.store.list('users')).length === 0) {
        role = 'admin';
        this.logger.warn(
          `ADMIN_EMAILS is not set — granting admin to the first racer to sign in (${email}). ` +
            `Set ADMIN_EMAILS in apps/api/.env to control this explicitly.`,
        );
      }

      const created: UserRecord = {
        id: input.googleId,
        googleId: input.googleId,
        email,
        domain,
        role,
        googleFullName: input.fullName,
        googleAvatarUrl: input.avatarUrl,
        displayName: input.fullName,
        avatarUrl: input.avatarUrl,
        tagline: 'No health, no levelling, no brakes.',
        favoriteRacer: RACERS[Math.floor(Math.random() * RACERS.length)],
        accentColor: ACCENT_COLORS[Math.floor(Math.random() * ACCENT_COLORS.length)],
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
        scores: { allTime: 0, monthly: {}, daily: {} },
        wins: [],
      };

      await this.store.write(this.fileFor(created.id), created);
      await this.index.rebuild();
      return created;
    });
  }

  async updateProfile(id: string, patch: ProfilePatch): Promise<PublicUser> {
    const updated = await this.store.transaction(async () => {
      const user = await this.requireRaw(id);
      const next: UserRecord = { ...user, updatedAt: new Date().toISOString() };

      if (patch.displayName !== undefined) {
        const name = patch.displayName.trim();
        if (name.length < 2 || name.length > 40) {
          throw new BadRequestException('Display name must be 2–40 characters');
        }
        next.displayName = name;
      }

      if (patch.avatarUrl !== undefined) {
        next.avatarUrl = this.sanitizeAvatarUrl(patch.avatarUrl, user.googleAvatarUrl);
      }

      if (patch.tagline !== undefined) {
        const tagline = patch.tagline.trim();
        if (tagline.length > 120) {
          throw new BadRequestException('Tagline must be 120 characters or fewer');
        }
        next.tagline = tagline;
      }

      if (patch.favoriteRacer !== undefined) {
        if (!RACERS.includes(patch.favoriteRacer as (typeof RACERS)[number])) {
          throw new BadRequestException('Unknown racer');
        }
        next.favoriteRacer = patch.favoriteRacer;
      }

      if (patch.accentColor !== undefined) {
        const color = patch.accentColor.trim().toUpperCase();
        if (!/^#[0-9A-F]{6}$/.test(color)) {
          throw new BadRequestException('Accent must be a #RRGGBB hex colour');
        }
        next.accentColor = color;
      }

      await this.store.write(this.fileFor(id), next);

      /*
       * Leaderboard entries cache the racer's identity (name, avatar, accent,
       * ride) so the client can render a board without cross-referencing the
       * roster. That means a profile edit has to re-stamp every derived board,
       * or the boards keep showing the old identity until this racer's next
       * win. Only rebuild when something a board actually displays changed.
       */
      const projectedFields = ['displayName', 'avatarUrl', 'accentColor', 'favoriteRacer'] as const;
      const projectionChanged = projectedFields.some((field) => next[field] !== user[field]);

      if (projectionChanged) {
        await this.boards.rebuildAll();
      } else {
        await this.index.rebuild();
      }

      return next;
    });

    return this.toPublic(updated);
  }

  /**
   * Avatars are either a remote https image or an inline data URL from the
   * client-side cropper. Anything else (javascript:, http:, oversized data
   * URLs) is rejected rather than silently stored.
   */
  private sanitizeAvatarUrl(value: string, fallback: string): string {
    const url = value.trim();
    if (!url) return fallback;

    if (url.startsWith('data:image/')) {
      // ~1.4MB of base64 ≈ 1MB image. Keeps the JSON files sane.
      if (url.length > 1_400_000) {
        throw new BadRequestException('Image too large — keep it under 1MB');
      }
      if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url)) {
        throw new BadRequestException('Unsupported inline image');
      }
      return url;
    }

    if (!/^https:\/\//i.test(url)) {
      throw new BadRequestException('Avatar URL must use https');
    }
    if (url.length > 2048) {
      throw new BadRequestException('Avatar URL too long');
    }
    return url;
  }

  toPublic(user: UserRecord): PublicUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.displayName,
      googleFullName: user.googleFullName,
      avatarUrl: user.avatarUrl,
      googleAvatarUrl: user.googleAvatarUrl,
      tagline: user.tagline,
      favoriteRacer: user.favoriteRacer,
      accentColor: user.accentColor,
      createdAt: user.createdAt,
      scores: user.scores,
    };
  }
}
