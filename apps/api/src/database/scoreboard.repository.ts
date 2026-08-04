import { Injectable } from '@nestjs/common';
import { DEFAULT_RACE_COLOR } from '../common/race-colors';
import { racerSlug } from '../common/racers';
import { MongoService } from './mongo.service';
import { MetricsService } from '../metrics/metrics.service';
import { DEFAULT_METRIC } from '../metrics/metrics.constants';
import type { LeaderboardEntry, PeriodKind, RaceColor, Scoreboard } from '@scrapyard/shared';
import { dayKey, monthKey, periodLabel } from '../common/period.util';

/** Trim float noise from averages and formula results. */
function tidy(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Scoreboards, computed on read.
 *
 * A board is a `$group` over the `games` collection, unwound by finisher. Every
 * metric — the built-in derived ones plus each admin-defined captured metric —
 * is aggregated in that single pass; formula metrics are folded in afterwards
 * from the per-racer totals. The client receives every metric per racer and the
 * column definitions, so it can sort any board by any column.
 *
 * With games as immutable events there is nothing to keep in step: drift isn't
 * prevented, it's impossible. No single-writer constraint either, so the app
 * scales to as many instances as you like.
 */
@Injectable()
export class ScoreboardRepository {
  constructor(
    private readonly mongo: MongoService,
    private readonly metrics: MetricsService,
  ) {}

  async board(kind: PeriodKind, key: string): Promise<Scoreboard> {
    const games = await this.mongo.games();
    const registry = await this.metrics.registry();
    const columns = this.metrics.columns(registry.enabled);

    const match =
      kind === 'all-time' ? {} : kind === 'monthly' ? { monthKey: key } : { dayKey: key };

    // Base aggregation: the derived metrics, plus each captured metric grouped
    // by its own aggregation. `cap_<id>` keeps captured fields namespaced.
    const group: Record<string, unknown> = {
      _id: '$results.racerId',
      wins: { $sum: { $cond: [{ $eq: ['$results.place', 1] }, 1, 0] } },
      podiums: { $sum: { $cond: [{ $lte: ['$results.place', 3] }, 1, 0] } },
      races: { $sum: 1 },
      gameScore: { $sum: '$results.gameScore' },
      bestScore: { $max: '$results.gameScore' },
      placeSum: { $sum: '$results.place' },
    };
    for (const metric of registry.captured) {
      const value = { $ifNull: [`$results.stats.${metric.id}`, 0] };
      const op =
        metric.aggregation === 'max' ? '$max' : metric.aggregation === 'avg' ? '$avg' : '$sum';
      group[`cap_${metric.id}`] = { [op]: value };
    }

    type Row = Record<string, number> & {
      _id: string;
      user: {
        displayName: string;
        avatarUrl: string;
        raceColor: RaceColor;
        favoriteRacer: string;
        useRacerArt?: boolean;
      };
    };

    const rows = await games
      .aggregate<Row>([
        { $match: match },
        { $unwind: '$results' },
        { $group: group },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: false } },
        // Descending wins, then name, so ties are ordered deterministically.
        { $sort: { wins: -1, 'user.displayName': 1 } },
      ])
      .toArray();

    const metricsFor = (row: Record<string, number>): Record<string, number> => {
      const races = row.races ?? 0;
      const base: Record<string, number> = {
        wins: row.wins ?? 0,
        podiums: row.podiums ?? 0,
        races,
        gameScore: row.gameScore ?? 0,
        bestScore: row.bestScore ?? 0,
        avgPlace: races > 0 ? tidy((row.placeSum ?? 0) / races) : 0,
      };
      for (const metric of registry.captured) base[metric.id] = tidy(row[`cap_${metric.id}`] ?? 0);
      const formulas = this.metrics.computeFormulas(base, registry.formulas);
      for (const [id, value] of Object.entries(formulas)) base[id] = tidy(value);
      return base;
    };

    const entries: LeaderboardEntry[] = [];
    let lastPrimary: number | null = null;
    let lastRank = 0;

    rows.forEach((row, position) => {
      const primary = row.wins ?? 0;
      const tied = lastPrimary === primary;
      const rank = tied ? lastRank : position + 1;
      if (!tied) {
        lastRank = rank;
        lastPrimary = primary;
      }
      const metrics = metricsFor(row);
      entries.push({
        rank,
        userId: row._id,
        displayName: row.user.displayName,
        avatarUrl: row.user.avatarUrl,
        raceColor: row.user.raceColor ?? DEFAULT_RACE_COLOR,
        favoriteRacer: row.user.favoriteRacer,
        racerSlug: racerSlug(row.user.favoriteRacer),
        useRacerArt: row.user.useRacerArt ?? false,
        primary: metrics[DEFAULT_METRIC] ?? 0,
        metrics,
        tied,
      });
    });

    // Racers with no result in this period don't appear in `games`; append them
    // with zeroed metrics so the "yet to score" strip can render.
    const users = await this.mongo.users();
    const scored = new Set(rows.map((r) => r._id));
    const unscored = await users
      .find(
        { _id: { $nin: [...scored] } },
        { projection: { displayName: 1, avatarUrl: 1, raceColor: 1, favoriteRacer: 1, useRacerArt: 1 } },
      )
      .sort({ displayName: 1 })
      .toArray();

    const zeroMetrics = metricsFor({} as Record<string, number>);
    const zeroRank = rows.length + 1;
    unscored.forEach((user, i) => {
      entries.push({
        rank: zeroRank,
        userId: user._id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        raceColor: user.raceColor ?? DEFAULT_RACE_COLOR,
        favoriteRacer: user.favoriteRacer,
        racerSlug: racerSlug(user.favoriteRacer),
        useRacerArt: user.useRacerArt ?? false,
        primary: 0,
        metrics: { ...zeroMetrics },
        tied: i > 0 || rows.length > 0,
      });
    });

    return {
      kind,
      key,
      label: periodLabel(kind, key),
      generatedAt: new Date().toISOString(),
      defaultMetric: DEFAULT_METRIC,
      columns,
      total: rows.reduce((sum, r) => sum + (r.wins ?? 0), 0),
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
   * Win counts (first-place finishes) per racer for the periods the UI renders,
   * plus two participation signals used to sort the racer picker: total races
   * entered (any place) and the timestamp of their most recent race. Both are
   * all-time only — a "raced recently" signal doesn't make sense split by
   * month/day the way win tallies do.
   *
   * Backs `GET /users` and the profile ranks.
   */
  async scoresByUser(): Promise<
    Map<
      string,
      {
        allTime: number;
        month: number;
        day: number;
        races: number;
        gameScore: number;
        lastAt: string | null;
      }
    >
  > {
    const games = await this.mongo.games();
    const month = monthKey();
    const day = dayKey();

    const rows = await games
      .aggregate<{
        _id: string;
        allTime: number;
        month: number;
        day: number;
        races: number;
        gameScore: number;
        lastAt: Date | null;
      }>([
        { $unwind: '$results' },
        {
          $group: {
            _id: '$results.racerId',
            allTime: { $sum: { $cond: [{ $eq: ['$results.place', 1] }, 1, 0] } },
            month: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$results.place', 1] }, { $eq: ['$monthKey', month] }] },
                  1,
                  0,
                ],
              },
            },
            day: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$results.place', 1] }, { $eq: ['$dayKey', day] }] },
                  1,
                  0,
                ],
              },
            },
            races: { $sum: 1 },
            // All-time only, like `races` beside it: this feeds the w/r/s trio
            // shown next to a racer's name, which is an all-time summary.
            gameScore: { $sum: '$results.gameScore' },
            lastAt: { $max: '$at' },
          },
        },
      ])
      .toArray();

    return new Map(
      rows.map((r) => [
        r._id,
        {
          allTime: r.allTime,
          month: r.month,
          day: r.day,
          races: r.races,
          gameScore: r.gameScore,
          lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : null,
        },
      ]),
    );
  }

  /** Every period that has at least one game, for the archive picker. */
  async knownPeriods(): Promise<{ months: string[]; days: string[] }> {
    const games = await this.mongo.games();
    const [months, days] = await Promise.all([
      games.distinct('monthKey'),
      games.distinct('dayKey'),
    ]);
    return {
      months: [...new Set([...months, monthKey()])].sort().reverse(),
      days: [...new Set([...days, dayKey()])].sort().reverse(),
    };
  }
}
