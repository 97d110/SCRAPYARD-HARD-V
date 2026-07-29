import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService, UserDoc } from '../database/mongo.service';
import { ScoreboardRepository } from '../database/scoreboard.repository';
import { allowedDomains, isAllowedEmail } from '../common/access';
import { blindIndex, decryptField, encryptField } from '../common/crypto';
import type { PublicUser, UserRecord, UserRole } from '@scrapyard/shared';
import { dayKey, monthKey } from '../common/period.util';

/** Mongo's duplicate-key error, without importing the driver's error classes. */
function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
}

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

  /** The one place `UserDoc` (encrypted, as stored) becomes `UserRecord` (plaintext, as used everywhere else). */
  private toRecord(doc: UserDoc): UserRecord {
    const { _id, emailEnc, emailHash: _emailHash, googleIdEnc, googleIdHash: _googleIdHash, ...rest } = doc;
    if (!emailEnc) {
      // Pre-encryption document — email/googleId are still plaintext fields
      // that no longer exist on UserDoc's type, so nothing here can read them.
      // A cryptic "Cannot read properties of undefined" is what this used to
      // surface as; naming the actual fix is more useful than a stack trace.
      throw new Error(
        `Racer ${_id} is still on the pre-encryption schema. ` +
          'Run `npm run migrate:encrypt-users` against this database, then restart the app.',
      );
    }
    return {
      id: _id,
      ...rest,
      email: decryptField(emailEnc),
      googleId: googleIdEnc ? decryptField(googleIdEnc) : undefined,
    };
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
    const doc = await users.findOne({ emailHash: blindIndex(email.trim().toLowerCase()) });
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
   * Called on every successful Google login. Three outcomes, in this order:
   *
   *   1. We already know this Google id  → refresh their Google-sourced fields.
   *   2. An unclaimed seat has this email → CLAIM it. This is the whole point
   *      of admin-created racers: the crew scores you from day one, and when
   *      you finally sign in you inherit that history instead of starting a
   *      second, empty account.
   *   3. Neither                          → create a racer, id = Google id.
   *
   * The lookup key is `googleId`, not `_id`. For anyone who signed in before
   * admin-created racers existed those are the same string, so this is
   * backwards compatible without a migration — but a claimed seat keeps the
   * `_id` it was created with, because every win document references it.
   */
  async upsertFromGoogle(input: UpsertFromGoogleInput): Promise<UserRecord> {
    const users = await this.mongo.users();
    const email = input.email.trim().toLowerCase();
    const emailHash = blindIndex(email);
    const now = new Date().toISOString();
    const googleId = this.assertId(input.googleId);
    const googleIdHash = blindIndex(googleId);

    const admins = this.adminEmails();
    let existing = await users.findOne({ googleIdHash });

    if (!existing) {
      /*
       * The email address is the real identity, so a returning person adopts
       * whatever seat already holds it — an admin-created one, a seeded one, or
       * one previously linked to a different Google id. We keep that seat's
       * `_id` untouched, which is precisely what preserves ALL of their history:
       * every game, score, stat and achievement derives from `_id`, so
       * re-pointing `googleId` at the new account changes nothing they own.
       *
       * This deliberately trusts the OAuth-verified, domain-restricted email as
       * the source of truth rather than refusing on a googleId mismatch.
       */
      existing = await users.findOne({ emailHash });
    }

    // Adoption keeps the seat's id; a brand-new racer gets the Google id.
    const id = existing?._id ?? googleId;
    const firstClaim = Boolean(existing) && !existing?.googleIdEnc;
    const relink = Boolean(existing?.googleIdEnc) && existing?.googleIdHash !== googleIdHash;
    if (firstClaim) {
      // Seat id only — never the address itself. It's PII, and it's the exact
      // field this whole change encrypts at rest; logging it plainly would
      // undo the point.
      this.logger.log(`Seat ${id} claimed via first Google sign-in`);
    } else if (relink) {
      this.logger.warn(`Seat ${id} re-linked to a new Google account — all history preserved`);
    }

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
        this.logger.log(`Seat ${id} ${role === 'admin' ? 'promoted to admin' : 'demoted to racer'}`);
      }
    } else if (existing?.googleIdEnc) {
      role = existing.role;
    } else {
      /*
       * Bootstrap: the first racer to *sign in* becomes admin so a fresh
       * install isn't locked out. Counting only claimed seats matters — a
       * database seeded with unclaimed racers must not swallow the bootstrap
       * and leave nobody able to administer anything.
       */
      const count = await users.countDocuments({ googleIdEnc: { $exists: true } }, { limit: 1 });
      role = count === 0 ? 'admin' : 'racer';
      if (role === 'admin') {
        this.logger.warn(
          `ADMIN_EMAILS is not set — granting admin to the first racer to sign in (seat ${id}). ` +
            'Set ADMIN_EMAILS to control this explicitly.',
        );
      }
    }

    /*
     * On a claim the document already exists, so $setOnInsert doesn't fire and
     * the admin's chosen display name survives untouched — which is what we
     * want, they picked it deliberately. The one thing worth backfilling is an
     * avatar, because an admin has no way to supply one and a blank face on
     * the leaderboard is a worse default than the racer's Google photo.
     */
    const backfill: Partial<UserDoc> = {};
    if ((firstClaim || relink) && !existing?.avatarUrl && input.avatarUrl) {
      backfill.avatarUrl = input.avatarUrl;
    }

    /*
     * `avatarUrl` must live in exactly one operator. It goes in $set only when
     * we're backfilling an existing seat (an insert never backfills, since that
     * requires `existing`), and otherwise in $setOnInsert for a brand-new racer.
     * Mongo rejects the same path appearing in both $set and $setOnInsert, which
     * is the "would create a conflict at 'avatarUrl'" error.
     */
    const setOnInsert: Partial<UserDoc> = {
      displayName: input.fullName || email.split('@')[0],
      tagline: 'No health, no levelling, no brakes.',
      favoriteRacer: RACERS[Math.floor(Math.random() * RACERS.length)],
      accentColor: ACCENT_COLORS[Math.floor(Math.random() * ACCENT_COLORS.length)],
      createdAt: now,
    };
    if (backfill.avatarUrl === undefined) {
      setOnInsert.avatarUrl = input.avatarUrl || '';
    }

    await users.updateOne(
      { _id: id },
      {
        $set: {
          googleIdEnc: encryptField(googleId),
          googleIdHash,
          emailEnc: encryptField(email),
          emailHash,
          role,
          googleFullName: input.fullName || existing?.googleFullName || email.split('@')[0],
          googleAvatarUrl: input.avatarUrl || existing?.googleAvatarUrl || '',
          lastLoginAt: now,
          updatedAt: now,
          ...backfill,
        },
        $setOnInsert: setOnInsert,
      },
      { upsert: true },
    );

    return this.requireRaw(id);
  }

  /**
   * Admin: add a racer who hasn't signed in yet.
   *
   * The crew shouldn't have to chase everyone through an OAuth flow before a
   * single race can be scored. The seat holds wins, appears on every board and
   * has a profile page from the moment it's created; the person attached to it
   * inherits all of it the first time they sign in (see upsertFromGoogle).
   *
   * The email is the join key, so it is validated against the same domain
   * allowlist that governs sign-in. Creating `rival@othercorp.com` would mint
   * a seat that no permitted account could ever claim.
   */
  async createUnclaimed(input: { email: string; displayName: string }): Promise<PublicUser> {
    const users = await this.mongo.users();
    const email = input.email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new BadRequestException('That does not look like an email address');
    }

    if (!isAllowedEmail(email)) {
      throw new BadRequestException(
        `Only ${allowedDomains().map((d) => `@${d}`).join(' / ')} addresses can race here`,
      );
    }

    const displayName = input.displayName.trim();
    if (displayName.length < 2 || displayName.length > 40) {
      throw new BadRequestException('Display name must be 2–40 characters');
    }

    const now = new Date().toISOString();
    const doc: UserDoc = {
      _id: randomUUID(),
      emailEnc: encryptField(email),
      emailHash: blindIndex(email),
      // Never granted here. ADMIN_EMAILS is reconciled at login and is the
      // only path to admin, so this can't become a privilege-escalation route.
      role: 'racer',
      googleFullName: displayName,
      googleAvatarUrl: '',
      displayName,
      avatarUrl: '',
      tagline: 'Signed up in absentia.',
      favoriteRacer: RACERS[Math.floor(Math.random() * RACERS.length)],
      accentColor: ACCENT_COLORS[Math.floor(Math.random() * ACCENT_COLORS.length)],
      createdAt: now,
      updatedAt: now,
    };

    try {
      await users.insertOne(doc);
    } catch (error) {
      // The unique index on emailHash is the real guard — checking first
      // would race with a second admin doing the same thing.
      if (isDuplicateKey(error)) {
        throw new ConflictException(`${email} is already on the roster`);
      }
      throw error;
    }

    this.logger.log(`Admin created unclaimed racer, seat ${doc._id}`);
    return this.toPublic(this.toRecord(doc));
  }

  /**
   * Admin: remove a racer.
   *
   * Deliberately narrow. Only an *unclaimed* seat with *no wins* can go, which
   * covers the real need (an admin mistyped an address) without offering a way
   * to erase somebody's history or evict a real person. Wins are the ledger;
   * nothing here should be able to rewrite it.
   */
  async deleteUnclaimed(id: string): Promise<void> {
    const users = await this.mongo.users();
    const games = await this.mongo.games();
    const user = await this.requireRaw(this.assertId(id));

    if (user.googleId) {
      throw new BadRequestException(
        `${user.displayName} has signed in — a claimed racer can't be deleted`,
      );
    }

    const scored = await games.countDocuments({ 'results.racerId': user.id }, { limit: 1 });
    if (scored > 0) {
      throw new BadRequestException(
        `${user.displayName} has races on record. Deleting would rewrite the leaderboard.`,
      );
    }

    await users.deleteOne({ _id: user.id });
    this.logger.log(`Admin deleted unclaimed racer, seat ${user.id}`);
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
    scores?: { allTime: number; month: number; day: number; races: number; lastAt: string | null },
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
      claimed: Boolean(user.googleId),
      scores: {
        allTime: scores?.allTime ?? 0,
        monthly: { [month]: scores?.month ?? 0 },
        daily: { [day]: scores?.day ?? 0 },
        races: scores?.races ?? 0,
        lastRaceAt: scores?.lastAt ?? null,
      },
    };
  }
}
