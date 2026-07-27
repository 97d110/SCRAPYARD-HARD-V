import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Collection, Db, IndexDescription, MongoClient } from 'mongodb';
import type { UserRole } from '@scrapyard/shared';

/**
 * The database. Three collections, no derived state.
 *
 *   users    one document per racer, _id = the Google `sub` claim
 *   wins     one immutable document per win — the only thing ever written
 *   content  a single 'puns' document
 *
 * There is deliberately no scoreboard collection. Boards are aggregations over
 * `wins`, computed on read. See ScoreboardRepository.
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
  _id: string;
  googleId: string;
  email: string;
  domain: string;
  role: UserRole;
  googleFullName: string;
  googleAvatarUrl: string;
  displayName: string;
  avatarUrl: string;
  tagline: string;
  favoriteRacer: string;
  accentColor: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

export interface WinDoc {
  _id: string;
  userId: string;
  /** Stored as a Date so Mongo can sort and range-query it natively. */
  at: Date;
  monthKey: string;
  dayKey: string;
  awardedBy: string;
  note?: string;
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

  async wins(): Promise<Collection<WinDoc>> {
    return (await this.db()).collection<WinDoc>('wins');
  }

  async content(): Promise<Collection<ContentDoc>> {
    return (await this.db()).collection<ContentDoc>('content');
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

    const winIndexes: IndexDescription[] = [
      // Profile page: this racer's wins, newest first.
      { key: { userId: 1, at: -1 }, name: 'userId_at' },
      // Daily and monthly boards group on these.
      { key: { dayKey: 1 }, name: 'dayKey' },
      { key: { monthKey: 1 }, name: 'monthKey' },
      // Streaks read (userId, dayKey) pairs without touching the documents.
      { key: { userId: 1, dayKey: 1 }, name: 'userId_dayKey' },
    ];

    try {
      await db.collection('wins').createIndexes(winIndexes);
      await db
        .collection('users')
        .createIndexes([{ key: { email: 1 }, name: 'email', unique: true }]);
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
