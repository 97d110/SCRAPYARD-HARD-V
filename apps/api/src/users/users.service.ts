import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MongoService, UserDoc } from '../database/mongo.service';
import { ScoreboardRepository } from '../database/scoreboard.repository';
import type { PublicUser, UserRecord, UserRole } from '@scrapyard/shared';
import { dayKey, monthKey } from '../common/period.util';

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
    private readonly mongo: MongoService,
    private readonly scoreboards: ScoreboardRepository,
  ) {}

  private assertId(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new BadRequestException('Malformed user id');
    }
    return id;
  }

  private adminEmails(): string[] {
    return (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }

  private toRecord(doc: UserDoc): UserRecord {
    const { _id, ...rest } = doc;
    return { id: _id, ...rest };
  }

  async findRaw(id: string): Promise<UserRecord | null> {
    const users = await this.mongo.users();
    const doc = await users.findOne({ _id: this.assertId(id) });
    return doc ? this.toRecord(doc) : null;
  }

  async requireRaw(id: string): Promise<UserRecord> {
    const user = await this.findRaw(id);
    if (!user) throw new NotFoundException(`No racer with id ${id}`);
    return user;
  }

  async findAllRaw(): Promise<UserRecord[]> {
    const users = await this.mongo.users();
    const docs = await users.find({}).sort({ displayName: 1 }).toArray();
    return docs.map((doc) => this.toRecord(doc));
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const users = await this.mongo.users();
    const doc = await users.findOne({ email: email.trim().toLowerCase() });
    return doc ? this.toRecord(doc) : null;
  }

  /**
   * The roster with win counts attached — the client's boot call.
   *
   * One aggregation covers every racer's counts, merged in a single pass,
   * rather than a query per user.
   */
  async findAll(): Promise<PublicUser[]> {
    const [records, scores] = await Promise.all([
      this.findAllRaw(),
      this.scoreboards.scoresByUser(),
    ]);

    return records
      .map((record) => this.toPublic(record, scores.get(record.id)))
      .sort(
        (a, b) =>
          b.scores.allTime - a.scores.allTime || a.displayName.localeCompare(b.displayName),
      );
  }

  async findOnePublic(id: string): Promise<PublicUser> {
    const record = await this.requireRaw(id);
    const scores = await this.scoreboards.scoresByUser();
    return this.toPublic(record, scores.get(id));
  }

  /**
   * Called on every successful Google login. Creates the racer on first sight,
   * otherwise refreshes the Google-sourced fields while leaving anything they
   * have customised alone.
   *
   * `updateOne` with upsert rather than read-then-write, so two simultaneous
   * logins can't produce a duplicate account.
   */
  async upsertFromGoogle(input: UpsertFromGoogleInput): Promise<UserRecord> {
    const users = await this.mongo.users();
    const email = input.email.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    const now = new Date().toISOString();
    const id = this.assertId(input.googleId);

    const admins = this.adminEmails();
    const existing = await users.findOne({ _id: id });

    /*
     * ADMIN_EMAILS is declarative and reconciled on EVERY login, not only at
     * creation — otherwise adding yourself to the list later would never take
     * effect. When configured it is the single source of truth: listed emails
     * are promoted, unlisted ones demoted.
     */
    let role: UserRole;
    if (admins.length > 0) {
      role = admins.includes(email) ? 'admin' : 'racer';
      if (existing && existing.role !== role) {
        this.logger.log(
          `${email} ${role === 'admin' ? 'promoted to admin' : 'demoted to racer'}`,
        );
      }
    } else if (existing) {
      role = existing.role;
    } else {
      // Bootstrap: first racer becomes admin so a fresh install isn't locked out.
      const count = await users.countDocuments({}, { limit: 1 });
      role = count === 0 ? 'admin' : 'racer';
      if (role === 'admin') {
        this.logger.warn(
          `ADMIN_EMAILS is not set — granting admin to the first racer to sign in (${email}). ` +
            'Set ADMIN_EMAILS to control this explicitly.',
        );
      }
    }

    await users.updateOne(
      { _id: id },
      {
        $set: {
          googleId: id,
          email,
          domain,
          role,
          googleFullName: input.fullName || existing?.googleFullName || email.split('@')[0],
          googleAvatarUrl: input.avatarUrl || existing?.googleAvatarUrl || '',
          lastLoginAt: now,
          updatedAt: now,
        },
        // Applied only when the document is created.
        $setOnInsert: {
          displayName: input.fullName || email.split('@')[0],
          avatarUrl: input.avatarUrl || '',
          tagline: 'No health, no levelling, no brakes.',
          favoriteRacer: RACERS[Math.floor(Math.random() * RACERS.length)],
          accentColor: ACCENT_COLORS[Math.floor(Math.random() * ACCENT_COLORS.length)],
          createdAt: now,
        },
      },
      { upsert: true },
    );

    return this.requireRaw(id);
  }

  async updateProfile(id: string, patch: ProfilePatch): Promise<PublicUser> {
    const users = await this.mongo.users();
    const current = await this.requireRaw(id);
    const update: Partial<UserDoc> = { updatedAt: new Date().toISOString() };

    if (patch.displayName !== undefined) {
      const name = patch.displayName.trim();
      if (name.length < 2 || name.length > 40) {
        throw new BadRequestException('Display name must be 2–40 characters');
      }
      update.displayName = name;
    }

    if (patch.avatarUrl !== undefined) {
      update.avatarUrl = this.sanitizeAvatarUrl(patch.avatarUrl, current.googleAvatarUrl);
    }

    if (patch.tagline !== undefined) {
      const tagline = patch.tagline.trim();
      if (tagline.length > 120) {
        throw new BadRequestException('Tagline must be 120 characters or fewer');
      }
      update.tagline = tagline;
    }

    if (patch.favoriteRacer !== undefined) {
      if (!RACERS.includes(patch.favoriteRacer as (typeof RACERS)[number])) {
        throw new BadRequestException('Unknown racer');
      }
      update.favoriteRacer = patch.favoriteRacer;
    }

    if (patch.accentColor !== undefined) {
      const color = patch.accentColor.trim().toUpperCase();
      if (!/^#[0-9A-F]{6}$/.test(color)) {
        throw new BadRequestException('Accent must be a #RRGGBB hex colour');
      }
      update.accentColor = color;
    }

    await users.updateOne({ _id: id }, { $set: update });

    /*
     * No cascade needed. Leaderboard rows join the user document at query time,
     * so a rename shows up on every board immediately. The file-based design had
     * to rewrite 40+ derived files to achieve the same effect.
     */
    return this.findOnePublic(id);
  }

  /**
   * Avatars are either a remote https image or an inline data URL from the
   * client-side cropper. Anything else is rejected rather than stored.
   */
  private sanitizeAvatarUrl(value: string, fallback: string): string {
    const url = value.trim();
    if (!url) return fallback;

    if (url.startsWith('data:image/')) {
      // ~1.4MB of base64 ≈ a 1MB image; Mongo's document cap is 16MB.
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

  toPublic(
    user: UserRecord,
    scores?: { allTime: number; month: number; day: number },
  ): PublicUser {
    const month = monthKey();
    const day = dayKey();
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
      scores: {
        allTime: scores?.allTime ?? 0,
        monthly: { [month]: scores?.month ?? 0 },
        daily: { [day]: scores?.day ?? 0 },
      },
    };
  }
}
