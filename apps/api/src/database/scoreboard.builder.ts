import { Injectable } from '@nestjs/common';
import { JsonStoreService } from './json-store.service';
import { IndexService } from './index.service';
import type { LeaderboardEntry, PeriodKind, ScoreboardFile, UserRecord } from '@scrapyard/shared';
import { dayKey, monthKey, periodLabel, scoreboardSlug } from '../common/period.util';

/**
 * Builds the derived `scores/*.json` files from the `users/*.json` files.
 *
 * This lives in the database layer, and reads user files directly from the
 * store rather than through UsersService, for one specific reason: *both*
 * UsersService (a rename must re-stamp every board) and ScoresService (a win
 * must re-tally every board) need to trigger the cascade. Routing it through
 * a store-level service keeps those two free of a circular dependency.
 *
 * Boards are always recomputed wholesale, never incremented, so a derived file
 * can't drift away from the source of truth.
 */
@Injectable()
export class ScoreboardBuilder {
  constructor(
    private readonly store: JsonStoreService,
    private readonly index: IndexService,
  ) {}

  private async allUsers(): Promise<UserRecord[]> {
    return this.store.readAll<UserRecord>('users');
  }

  /** Recompute one board and write it. */
  async write(kind: PeriodKind, key: string, users?: UserRecord[]): Promise<ScoreboardFile> {
    const board = this.build(kind, key, users ?? (await this.allUsers()));
    await this.store.write(`scores/${scoreboardSlug(kind, key)}.json`, board);
    return board;
  }

  /** Recompute the three boards a single win touches. */
  async writeForWin(
    month: string,
    day: string,
    users?: UserRecord[],
  ): Promise<[ScoreboardFile, ScoreboardFile, ScoreboardFile]> {
    const roster = users ?? (await this.allUsers());
    return [
      await this.write('all-time', 'all-time', roster),
      await this.write('monthly', month, roster),
      await this.write('daily', day, roster),
    ];
  }

  /**
   * Recompute every board that any user has data for, then refresh the index.
   *
   * Called after a win, and after any profile edit that changes what a board
   * displays (name, avatar, accent, ride) — otherwise the boards would keep
   * showing a racer's old identity until their next win.
   *
   * Also deletes boards no surviving user has data for. Without that step,
   * removing a user file (e.g. `rm database/users/seed-*.json`) would leave
   * their historical periods on disk forever, still listing them, and the
   * index would keep advertising those files.
   */
  async rebuildAll(): Promise<ScoreboardFile[]> {
    const users = await this.allUsers();

    const months = new Set<string>([monthKey()]);
    const days = new Set<string>([dayKey()]);
    for (const user of users) {
      Object.keys(user.scores.monthly).forEach((key) => months.add(key));
      Object.keys(user.scores.daily).forEach((key) => days.add(key));
    }

    const boards: ScoreboardFile[] = [await this.write('all-time', 'all-time', users)];
    for (const key of [...months].sort()) boards.push(await this.write('monthly', key, users));
    for (const key of [...days].sort()) boards.push(await this.write('daily', key, users));

    // Anything in scores/ we didn't just write is stale — drop it.
    const expected = new Set(boards.map((board) => `${scoreboardSlug(board.kind, board.key)}.json`));
    for (const file of await this.store.list('scores')) {
      if (!expected.has(file)) await this.store.remove(`scores/${file}`);
    }

    await this.index.rebuild();
    return boards;
  }

  /** Read a persisted board, falling back to computing an empty one. */
  async read(kind: PeriodKind, key: string): Promise<ScoreboardFile> {
    const existing = await this.store.read<ScoreboardFile>(
      `scores/${scoreboardSlug(kind, key)}.json`,
    );
    if (existing) return existing;
    // Never 404 a leaderboard — a period nobody scored in is a valid answer.
    return this.build(kind, key, await this.allUsers());
  }

  async list(): Promise<ScoreboardFile[]> {
    return this.store.readAll<ScoreboardFile>('scores');
  }

  /** Pure projection: user files in, ranked board out. */
  build(kind: PeriodKind, key: string, users: UserRecord[]): ScoreboardFile {
    const pointsOf = (user: UserRecord): number => {
      if (kind === 'all-time') return user.scores.allTime;
      if (kind === 'monthly') return user.scores.monthly[key] ?? 0;
      return user.scores.daily[key] ?? 0;
    };

    const ranked = users
      .map((user) => ({ user, points: pointsOf(user) }))
      .sort(
        (a, b) => b.points - a.points || a.user.displayName.localeCompare(b.user.displayName),
      );

    let lastPoints: number | null = null;
    let lastRank = 0;

    const entries: LeaderboardEntry[] = ranked.map((row, position) => {
      const tied = lastPoints === row.points;
      const rank = tied ? lastRank : position + 1;
      if (!tied) {
        lastRank = rank;
        lastPoints = row.points;
      }
      return {
        rank,
        userId: row.user.id,
        displayName: row.user.displayName,
        avatarUrl: row.user.avatarUrl,
        accentColor: row.user.accentColor,
        favoriteRacer: row.user.favoriteRacer,
        points: row.points,
        tied,
      };
    });

    return {
      kind,
      key,
      label: periodLabel(kind, key),
      generatedAt: new Date().toISOString(),
      totalPoints: entries.reduce((sum, entry) => sum + entry.points, 0),
      entries,
    };
  }
}
