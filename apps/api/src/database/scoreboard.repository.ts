import { Injectable } from '@nestjs/common';
import { MongoService } from './mongo.service';
import type { LeaderboardEntry, PeriodKind, Scoreboard } from '@scrapyard/shared';
import { dayKey, monthKey, periodLabel } from '../common/period.util';

/**
 * Scoreboards, computed on read.
 *
 * This file replaces what used to be ~200 lines across ScoreboardBuilder,
 * IndexService and a five-file write cascade guarded by an in-process mutex.
 * All of that existed to keep derived copies in step with the source of truth.
 *
 * With wins as immutable events there is nothing to keep in step: a board is a
 * `$group` over the `wins` collection. Drift isn't prevented, it's impossible.
 * That also means no single-writer constraint, so the app can run on as many
 * instances as you like.
 */
@Injectable()
export class ScoreboardRepository {
  constructor(private readonly mongo: MongoService) {}

  /**
   * One period's board.
   *
   * A `$lookup` back onto `users` attaches the display fields, so the client can
   * render a row without cross-referencing the roster. `$unwind` with
   * `preserveNullAndEmptyArrays: false` quietly drops wins whose racer has been
   * deleted — which is the orphan cleanup we used to run by hand.
   */
  async board(kind: PeriodKind, key: string): Promise<Scoreboard> {
    const wins = await this.mongo.wins();

    const match =
      kind === 'all-time' ? {} : kind === 'monthly' ? { monthKey: key } : { dayKey: key };

    const rows = await wins
      .aggregate<{
        _id: string;
        points: number;
        user: {
          displayName: string;
          avatarUrl: string;
          accentColor: string;
          favoriteRacer: string;
        };
      }>([
        { $match: match },
        { $group: { _id: '$userId', points: { $sum: 1 } } },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'user',
          },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: false } },
        {
          $project: {
            points: 1,
            'user.displayName': 1,
            'user.avatarUrl': 1,
            'user.accentColor': 1,
            'user.favoriteRacer': 1,
          },
        },
        // Descending points, then name, so ties are ordered deterministically.
        { $sort: { points: -1, 'user.displayName': 1 } },
      ])
      .toArray();

    /*
     * Racers with zero wins in this period don't appear in `wins` at all, so
     * they're appended here. The UI shows them as a "yet to score" strip.
     */
    const users = await this.mongo.users();
    const scored = new Set(rows.map((r) => r._id));
    const unscored = await users
      .find(
        { _id: { $nin: [...scored] } },
        { projection: { displayName: 1, avatarUrl: 1, accentColor: 1, favoriteRacer: 1 } },
      )
      .sort({ displayName: 1 })
      .toArray();

    const entries: LeaderboardEntry[] = [];
    let lastPoints: number | null = null;
    let lastRank = 0;

    rows.forEach((row, position) => {
      const tied = lastPoints === row.points;
      const rank = tied ? lastRank : position + 1;
      if (!tied) {
        lastRank = rank;
        lastPoints = row.points;
      }
      entries.push({
        rank,
        userId: row._id,
        displayName: row.user.displayName,
        avatarUrl: row.user.avatarUrl,
        accentColor: row.user.accentColor,
        favoriteRacer: row.user.favoriteRacer,
        points: row.points,
        tied,
      });
    });

    const zeroRank = rows.length + 1;
    unscored.forEach((user, i) => {
      entries.push({
        rank: zeroRank,
        userId: user._id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        accentColor: user.accentColor,
        favoriteRacer: user.favoriteRacer,
        points: 0,
        tied: i > 0 || rows.length > 0,
      });
    });

    return {
      kind,
      key,
      label: periodLabel(kind, key),
      generatedAt: new Date().toISOString(),
      totalPoints: rows.reduce((sum, r) => sum + r.points, 0),
      entries,
    };
  }

  /** The three boards the main page opens with. */
  async currentBoards(): Promise<{
    allTime: Scoreboard;
    monthly: Scoreboard;
    daily: Scoreboard;
  }> {
    const [allTime, monthly, daily] = await Promise.all([
      this.board('all-time', 'all-time'),
      this.board('monthly', monthKey()),
      this.board('daily', dayKey()),
    ]);
    return { allTime, monthly, daily };
  }

  /**
   * Win counts per racer for the periods the UI renders.
   *
   * One aggregation for the whole roster rather than N queries — this backs
   * `GET /users`, which the client calls on boot.
   */
  async scoresByUser(): Promise<
    Map<string, { allTime: number; month: number; day: number }>
  > {
    const wins = await this.mongo.wins();
    const month = monthKey();
    const day = dayKey();

    const rows = await wins
      .aggregate<{ _id: string; allTime: number; month: number; day: number }>([
        {
          $group: {
            _id: '$userId',
            allTime: { $sum: 1 },
            month: { $sum: { $cond: [{ $eq: ['$monthKey', month] }, 1, 0] } },
            day: { $sum: { $cond: [{ $eq: ['$dayKey', day] }, 1, 0] } },
          },
        },
      ])
      .toArray();

    return new Map(rows.map((r) => [r._id, { allTime: r.allTime, month: r.month, day: r.day }]));
  }

  /** Every period that has at least one win, for the archive picker. */
  async knownPeriods(): Promise<{ months: string[]; days: string[] }> {
    const wins = await this.mongo.wins();
    const [months, days] = await Promise.all([
      wins.distinct('monthKey'),
      wins.distinct('dayKey'),
    ]);
    return {
      months: [...new Set([...months, monthKey()])].sort().reverse(),
      days: [...new Set([...days, dayKey()])].sort().reverse(),
    };
  }
}
