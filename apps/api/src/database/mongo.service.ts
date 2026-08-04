import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Collection, Db, IndexDescription, MongoClient } from 'mongodb';
import type { RaceColor, UserRole } from '@scrapyard/shared';

/**
 * The database. A handful of collections, no derived state.
 *
 *   users            one document per racer, _id = the Google `sub` claim
 *   games            one immutable document per race — the event log
 *   metrics          admin-defined captured & formula metrics (config)
 *   achievementRules admin-defined metric-threshold badges (config)
 *   content          a single 'puns' document
 *
 * There is deliberately no scoreboard collection. Boards and achievements are
 * aggregations over `games`, computed on read. See ScoreboardRepository.
 *
 * ── One client, reused ──────────────────────────────────────────────────────
 *
 * Render runs a single long-lived process, so the client is created once at
 * first use and kept for the lifetime of the service. Two details still matter:
 *
 *  - The connect *promise* is cached, not just the resolved client, so requests
 *    arriving during startup share one handshake instead of racing to open
 *    several.
 *  - It lives on `globalThis` rather than the instance, so `ts-node --watch` in
 *    development doesn't leak a connection on every reload.
 *
 * Atlas's free tier allows 500 connections; a single process with a pool of 5
 * is nowhere near that.
 */

export interface UserDoc {
  /**
   * Permanent, opaque, and deliberately NOT the Google id.
   *
   * A racer can exist before they ever sign in — an admin creates them by
   * email so the crew can score them from day one. That racer has no Google
   * id yet, and when they finally sign in we must attach it *without* changing
   * `_id`, because every document in `wins` points at it. Mongo can't rename
   * an `_id`, so the two identities have to be separate fields.
   *
   * For racers who signed in first, `_id` happens to equal `googleId`. That is
   * history, not a rule — never rely on it.
   */
  _id: string;
  /**
   * Email and Google id are the only two fields here that aren't already
   * shown to every signed-in teammate, so they're the only two encrypted.
   * `*Enc` is AES-256-GCM ciphertext (decrypt with `decryptField`); `*Hash`
   * is an HMAC-SHA-256 blind index — the only thing Mongo can match or
   * enforce uniqueness on, since the ciphertext itself is never the same
   * twice for the same value. See `common/crypto.ts`.
   */
  emailEnc: string;
  emailHash: string;
  /** Absent until the racer completes a Google sign-in and claims the seat. */
  googleIdEnc?: string;
  googleIdHash?: string;
  role: UserRole;
  googleFullName: string;
  googleAvatarUrl: string;
  displayName: string;
  avatarUrl: string;
  tagline: string;
  favoriteRacer: string;
  accentColor: string;
  /**
   * Plaintext, like `displayName` and `googleFullName` beside it — these are
   * already shown to every signed-in teammate, so the encryption rule above
   * (email and Google id only) deliberately doesn't extend to them.
   */
  raceColor: RaceColor | null;
  hebrewAliases: string[];
  createdAt: string;
  updatedAt: string;
  /** Absent for a racer who has never signed in. */
  lastLoginAt?: string;
}

/** One racer's finish inside a game document. */
export interface GameResultDoc {
  racerId: string;
  place: number;
  gameScore: number;
  /** Captured metric values, keyed by metric id. kills/deaths derive from events. */
  stats: Record<string, number>;
}

/** One directed kill inside a game. `revenge` is resolved at write time. */
export interface KillEventDoc {
  killerId: string;
  victimId: string;
  revenge: boolean;
}

/**
 * One document in the `games` collection — an immutable race event.
 *
 * Replaces the old single-winner `wins` document. Each game carries 2–4
 * finishers with their place, in-game score and captured stats. Boards and
 * achievements are aggregations over this collection, computed on read, so
 * there is still nothing derived to keep in step.
 */
export interface GameDoc {
  _id: string;
  /** Stored as a Date so Mongo can sort and range-query it natively. */
  at: Date;
  monthKey: string;
  dayKey: string;
  awardedBy: string;
  note?: string;
  results: GameResultDoc[];
  /** The kill log — killer→victim events with revenge resolved. */
  events: KillEventDoc[];
}

/**
 * An admin-defined metric (captured or formula). Built-in derived metrics are
 * code constants, not documents — see metrics.constants.ts.
 */
export interface MetricDoc {
  _id: string;
  label: string;
  icon: string;
  unit?: string;
  description?: string;
  kind: 'captured' | 'formula';
  aggregation: 'sum' | 'max' | 'avg' | 'last';
  /** Present for formula metrics: weighted terms over other metrics. */
  formula?: Array<{ metricId: string; weight: number }>;
  order: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An admin-defined achievement rule: a metric threshold within a scope. */
export interface AchievementRuleDoc {
  _id: string;
  name: string;
  description: string;
  tier: 'bronze' | 'silver' | 'gold' | 'plasma';
  icon: string;
  metricId: string;
  scope: 'all-time' | 'monthly' | 'daily' | 'game';
  threshold: number;
  order: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContentDoc {
  _id: string;
  label: string;
  updatedAt: string;
  items: Array<{
    id: string;
    text: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
}

/**
 * One browser's Web Push subscription. `_id` is the endpoint URL itself —
 * that's already the unique key a push service hands out per subscribed
 * device, so there's no need for a separate generated id or a unique index.
 */
export interface PushSubscriptionDoc {
  _id: string;
  userId: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
  userAgent?: string;
}

/** Cache slot on globalThis — survives dev-server reloads. */
interface MongoGlobal {
  client?: MongoClient;
  connecting?: Promise<MongoClient>;
}

const cache: MongoGlobal = ((
  globalThis as unknown as { __scrapyardMongo?: MongoGlobal }
).__scrapyardMongo ??= {});

@Injectable()
export class MongoService implements OnModuleDestroy {
  private readonly logger = new Logger(MongoService.name);
  private indexesEnsured = false;

  private uri(): string {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error(
        'MONGODB_URI is not set. Scrapyard stores everything in MongoDB — ' +
          'see the README for an Atlas connection string.',
      );
    }
    return uri;
  }

  private dbName(): string {
    return process.env.MONGODB_DB || 'scrapyard';
  }

  /** The shared client, connecting on first use and reused thereafter. */
  async client(): Promise<MongoClient> {
    if (cache.client) return cache.client;

    // Two concurrent cold requests must share one handshake, not race.
    cache.connecting ??= (async () => {
      const client = new MongoClient(this.uri(), {
        // Comfortably serves one process; well under Atlas's 500 ceiling even
        // if you later run several instances.
        maxPoolSize: 10,
        minPoolSize: 0,
        // Fail fast rather than hanging a request for 30s on a bad URI.
        serverSelectionTimeoutMS: 8000,
        retryWrites: true,
      });
      await client.connect();
      this.logger.log(`Connected to MongoDB (db: ${this.dbName()})`);
      cache.client = client;
      return client;
    })();

    try {
      return await cache.connecting;
    } catch (error) {
      // Let the next request retry instead of caching a failed promise forever.
      cache.connecting = undefined;
      throw error;
    }
  }

  async db(): Promise<Db> {
    const client = await this.client();
    const db = client.db(this.dbName());
    await this.ensureIndexes(db);
    return db;
  }

  async users(): Promise<Collection<UserDoc>> {
    return (await this.db()).collection<UserDoc>('users');
  }

  async games(): Promise<Collection<GameDoc>> {
    return (await this.db()).collection<GameDoc>('games');
  }

  async metrics(): Promise<Collection<MetricDoc>> {
    return (await this.db()).collection<MetricDoc>('metrics');
  }

  async achievementRules(): Promise<Collection<AchievementRuleDoc>> {
    return (await this.db()).collection<AchievementRuleDoc>('achievementRules');
  }

  async content(): Promise<Collection<ContentDoc>> {
    return (await this.db()).collection<ContentDoc>('content');
  }

  async pushSubscriptions(): Promise<Collection<PushSubscriptionDoc>> {
    return (await this.db()).collection<PushSubscriptionDoc>('pushSubscriptions');
  }

  /**
   * Indexes, created once per process.
   *
   * `createIndexes` is idempotent, but it's still a round trip, so the flag
   * keeps it off the hot path after the first call.
   */
  private async ensureIndexes(db: Db): Promise<void> {
    if (this.indexesEnsured) return;
    this.indexesEnsured = true;

    const gameIndexes: IndexDescription[] = [
      // Profile page and the global daily timeline: newest first.
      { key: { at: -1 }, name: 'at' },
      // Daily and monthly boards group on these.
      { key: { dayKey: 1 }, name: 'dayKey' },
      { key: { monthKey: 1 }, name: 'monthKey' },
      // Per-racer scans (profile, streaks) match on a result's racerId.
      { key: { 'results.racerId': 1, at: -1 }, name: 'resultsRacerId_at' },
    ];

    try {
      await db.collection('games').createIndexes(gameIndexes);
      // Metric and rule ordering.
      await db.collection('metrics').createIndexes([{ key: { order: 1 }, name: 'order' }]);
      await db.collection('achievementRules').createIndexes([{ key: { order: 1 }, name: 'order' }]);
      /*
       * Pre-encryption installs had unique indexes directly on plaintext
       * `email`/`googleId`. Those fields no longer exist on a document once
       * it's migrated (see migrate-encrypt-users.ts), and a *non-sparse*
       * unique index treats every document missing the field as colliding on
       * `null` — so the old index must go before it can break the second
       * migrated write. Dropping is safe to attempt on every boot: it's a
       * no-op once the index is already gone, which is the common case.
       */
      for (const legacyIndex of ['email', 'googleId']) {
        try {
          await db.collection('users').dropIndex(legacyIndex);
        } catch {
          // Already gone, or a fresh install that never had it. Either way, fine.
        }
      }

      await db.collection('users').createIndexes([
        // One seat per address — this is what makes claim-by-email safe.
        { key: { emailHash: 1 }, name: 'emailHash', unique: true },
        /*
         * Sparse, so the many unclaimed racers (no googleId at all) don't
         * collide with each other on a missing value. Unique, so one Google
         * account can never end up attached to two seats.
         */
        { key: { googleIdHash: 1 }, name: 'googleIdHash', unique: true, sparse: true },
      ]);

      // Not for the fan-out send (that reads every document) — for looking up
      // or clearing one racer's subscriptions without a full collection scan.
      await db
        .collection('pushSubscriptions')
        .createIndexes([{ key: { userId: 1 }, name: 'userId' }]);
    } catch (error) {
      // A read-only user or a race with another instance shouldn't take the
      // app down — the queries still work, just less efficiently.
      this.indexesEnsured = false;
      this.logger.warn(
        `Could not ensure indexes: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Close cleanly on shutdown so Render's deploys don't leak connections. */
  async onModuleDestroy(): Promise<void> {
    if (cache.client) {
      await cache.client.close();
      cache.client = undefined;
      cache.connecting = undefined;
    }
  }
}
