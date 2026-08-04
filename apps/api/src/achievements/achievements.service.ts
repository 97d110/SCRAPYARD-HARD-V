import { Injectable } from '@nestjs/common';
import { DEFAULT_RACE_COLOR, UsersService } from '../users/users.service';
import { MongoService } from '../database/mongo.service';
import { ScoreboardRepository } from '../database/scoreboard.repository';
import { MetricsService, MetricRegistry } from '../metrics/metrics.service';
import { AchievementRulesService } from './achievement-rules.service';
import { aggregate, basePerGame } from '../metrics/metrics.constants';
import type {
  AchievementDef,
  RaceColor,
  AchievementRule,
  AchievementScope,
  AchievementState,
  GameParticipation,
  GameResult,
  KillEvent,
  MetricAggregation,
  MetricColumn,
  ProfileBundle,
  Rival,
  StreakSummary,
} from '@scrapyard/shared';
import { dayKey, dayKeyDiff, minuteOfDay, recentDayKeys } from '../common/period.util';

/**
 * Happy Hour window, in minutes since midnight (configured timezone).
 * 16:30 → 990, 19:00 → 1140. Half-open: a win at exactly 19:00 is outside.
 */
const HAPPY_HOUR_START = 16 * 60 + 30;
const HAPPY_HOUR_END = 19 * 60;

/**
 * The coded "special" achievements — the ones that aren't a simple metric
 * threshold and so can't be expressed as an admin rule. Everything else (win
 * tiers, N-in-a-day, points milestones, kills…) is a rule in the
 * `achievementRules` collection.
 */
const SPECIALS: AchievementDef[] = [
  { id: 'happy_hour', name: 'Happy Hour', description: 'Win a race between 16:30 and 19:00.', tier: 'silver', icon: 'beer', source: 'special' },
  { id: 'back_to_back', name: 'Back-to-Back', description: 'Win 3 races in a row in one day, with nobody else winning in between.', tier: 'gold', icon: 'flame', source: 'special' },
  { id: 'streak_3', name: 'Three-Day Burn', description: 'Win on 3 consecutive days.', tier: 'bronze', icon: 'flame', source: 'special' },
  { id: 'streak_7', name: 'Perfect Week', description: 'Win on 7 consecutive days.', tier: 'gold', icon: 'calendar-check', source: 'special' },
  { id: 'streak_14', name: 'Unstoppable', description: 'Win on 14 consecutive days.', tier: 'plasma', icon: 'infinity', source: 'special' },
  { id: 'lead_1', name: 'Day Crown', description: 'Finish #1 on a daily leaderboard.', tier: 'bronze', icon: 'medal', source: 'special' },
  { id: 'lead_5', name: 'Serial Champion', description: 'Top the daily board on 5 different days.', tier: 'silver', icon: 'medal', source: 'special' },
  { id: 'lead_streak_3', name: 'Dynasty', description: 'Top the daily board 3 days running.', tier: 'gold', icon: 'swords', source: 'special' },
  { id: 'monthly_monarch', name: 'Monthly Monarch', description: 'Sit at #1 on the current monthly board.', tier: 'gold', icon: 'crown', source: 'special' },
  { id: 'comeback', name: 'Comeback Kid', description: 'Win again after 7+ days away.', tier: 'silver', icon: 'undo', source: 'special' },
  { id: 'all_rounder', name: 'All-Round', description: 'Win in 3 different calendar months.', tier: 'gold', icon: 'globe', source: 'special' },
];

/** One racer's participation in a race, timestamp kept as a Date. */
interface ParticipationRow {
  gameId: string;
  at: Date;
  dayKey: string;
  monthKey: string;
  note?: string;
  fieldSize: number;
  place: number;
  gameScore: number;
  stats: Record<string, number>;
  /** The race's full kill log. */
  events: KillEvent[];
  /** Base (derived + captured) metric values for this single race. */
  base: Record<string, number>;
}

type DayCounts = Map<string, number>;

@Injectable()
export class AchievementsService {
  constructor(
    private readonly users: UsersService,
    private readonly mongo: MongoService,
    private readonly scoreboards: ScoreboardRepository,
    private readonly metrics: MetricsService,
    private readonly rules: AchievementRulesService,
  ) {}

  /** Every badge definition — coded specials plus admin rules. */
  async definitions(): Promise<AchievementDef[]> {
    const rules = await this.rules.rules();
    const ruleDefs: AchievementDef[] = rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      tier: rule.tier,
      icon: rule.icon,
      source: 'rule',
    }));
    return [...SPECIALS, ...ruleDefs];
  }

  /** Everything the profile page needs, in one shot. */
  async buildProfile(userId: string): Promise<ProfileBundle> {
    const record = await this.users.requireRaw(userId);

    const [registry, rules, rows, winDayByUser, scores, roster] = await Promise.all([
      this.metrics.registry(),
      this.rules.enabledRules(),
      this.participationRows(userId),
      this.winsByUserByDay(),
      this.scoreboards.scoresByUser(),
      this.rosterLite(),
    ]);

    const capturedIds = registry.captured.map((m) => m.id);
    for (const row of rows) row.base = basePerGame(this.asResult(row), capturedIds);

    const enabledIds = registry.enabled.map((m) => m.id);
    const columns: MetricColumn[] = this.metrics.columns(registry.enabled);
    const aggregationFor = (id: string): MetricAggregation =>
      registry.byId.get(id)?.aggregation ?? 'sum';

    const chrono = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
    const scope = this.scopeMaps(chrono, registry, aggregationFor);

    const totals: Record<string, number> = {};
    for (const id of enabledIds) totals[id] = round(scope['all-time'][id] ?? 0);

    const myWinsByDay: DayCounts = winDayByUser.get(userId) ?? new Map();
    const leaders = this.dailyLeaders(winDayByUser);
    const streaks = this.computeStreaks(userId, myWinsByDay, leaders, rows);

    // Back-to-back needs the cross-racer timeline, so resolve it up front.
    const backToBackAt = await this.resolveBackToBack(userId, myWinsByDay);

    const achievements = this.evaluate({
      userId,
      chrono,
      rules,
      registry,
      scope,
      aggregationFor,
      streaks,
      leaders,
      backToBackAt,
      monthlyLeader: this.isMonthlyLeader(userId, scores),
    });

    const recentGames: GameParticipation[] = rows.slice(0, 25).map((row) => {
      const combined = { ...row.base, ...this.metrics.computeFormulas(row.base, registry.formulas) };
      const metrics: Record<string, number> = {};
      for (const id of enabledIds) metrics[id] = round(combined[id] ?? 0);
      return {
        gameId: row.gameId,
        at: row.at.toISOString(),
        dayKey: row.dayKey,
        monthKey: row.monthKey,
        ...(row.note ? { note: row.note } : {}),
        place: row.place,
        fieldSize: row.fieldSize,
        gameScore: row.gameScore,
        metrics,
        // Only this racer's own kills and deaths — the rest of the field's
        // scuffles aren't their story.
        events: row.events.filter((e) => e.killerId === userId || e.victimId === userId),
      };
    });

    return {
      user: this.users.toPublic(record, scores.get(userId)),
      streaks,
      achievements,
      totals,
      columns,
      ranks: {
        allTime: this.rank(userId, scores, (s) => s.allTime),
        monthly: this.rank(userId, scores, (s) => s.month),
        daily: this.rank(userId, scores, (s) => s.day),
      },
      recentGames,
      rivals: this.computeRivals(userId, rows, roster),
      activity: this.activityWindow(myWinsByDay, 90),
    };
  }

  /** Minimal display fields for every racer, for the rivals panel. */
  private async rosterLite(): Promise<
    Map<string, { displayName: string; avatarUrl: string; raceColor: RaceColor }>
  > {
    const users = await this.mongo.users();
    const docs = await users
      .find({}, { projection: { displayName: 1, avatarUrl: 1, raceColor: 1 } })
      .toArray();
    return new Map(
      docs.map((d) => [
        d._id,
        { displayName: d.displayName, avatarUrl: d.avatarUrl, raceColor: d.raceColor ?? DEFAULT_RACE_COLOR },
      ]),
    );
  }

  /**
   * Head-to-head rivalries from every kill this racer was involved in. Sorted
   * worst-nemesis-first (they killed you most), then by your own body count
   * against them, so the panel leads with who's been hunting you.
   */
  private computeRivals(
    userId: string,
    rows: ParticipationRow[],
    roster: Map<string, { displayName: string; avatarUrl: string; raceColor: RaceColor }>,
  ): Rival[] {
    const tally = new Map<string, { youKilledThem: number; theyKilledYou: number; yourRevenges: number }>();
    const bump = (id: string): { youKilledThem: number; theyKilledYou: number; yourRevenges: number } => {
      const row = tally.get(id) ?? { youKilledThem: 0, theyKilledYou: 0, yourRevenges: 0 };
      tally.set(id, row);
      return row;
    };

    for (const row of rows) {
      for (const event of row.events) {
        if (event.killerId === userId && event.victimId !== userId) {
          const r = bump(event.victimId);
          r.youKilledThem += 1;
          if (event.revenge) r.yourRevenges += 1;
        } else if (event.victimId === userId && event.killerId !== userId) {
          bump(event.killerId).theyKilledYou += 1;
        }
      }
    }

    return [...tally.entries()]
      .map(([opponentId, counts]) => {
        const who = roster.get(opponentId);
        return {
          userId: opponentId,
          displayName: who?.displayName ?? 'Unknown racer',
          avatarUrl: who?.avatarUrl ?? '',
          raceColor: who?.raceColor ?? DEFAULT_RACE_COLOR,
          ...counts,
        };
      })
      .sort((a, b) => b.theyKilledYou - a.theyKilledYou || b.youKilledThem - a.youKilledThem)
      .slice(0, 8);
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  /** This racer's races, newest first, each reduced to their own finish. */
  private async participationRows(userId: string): Promise<ParticipationRow[]> {
    const games = await this.mongo.games();
    const docs = await games
      .aggregate<{
        _id: string;
        at: Date;
        dayKey: string;
        monthKey: string;
        note?: string;
        fieldSize: number;
        events?: KillEvent[];
        result: { racerId: string; place: number; gameScore: number; stats?: Record<string, number> };
      }>([
        { $match: { 'results.racerId': userId } },
        {
          $project: {
            at: 1,
            dayKey: 1,
            monthKey: 1,
            note: 1,
            events: 1,
            fieldSize: { $size: '$results' },
            result: {
              $arrayElemAt: [
                { $filter: { input: '$results', as: 'r', cond: { $eq: ['$$r.racerId', userId] } } },
                0,
              ],
            },
          },
        },
        { $sort: { at: -1 } },
      ])
      .toArray();

    return docs.map((doc) => ({
      gameId: doc._id,
      at: doc.at,
      dayKey: doc.dayKey,
      monthKey: doc.monthKey,
      note: doc.note,
      fieldSize: doc.fieldSize,
      events: doc.events ?? [],
      place: doc.result.place,
      gameScore: doc.result.gameScore,
      stats: doc.result.stats ?? {},
      base: {},
    }));
  }

  private asResult(row: ParticipationRow): GameResult {
    // A throwaway shim for formula math only — color is irrelevant here and
    // never read, so any valid value satisfies the type.
    return { racerId: '', place: row.place, gameScore: row.gameScore, stats: row.stats };
  }

  /** Every racer's first-place counts per day — powers streaks and leaders. */
  private async winsByUserByDay(): Promise<Map<string, DayCounts>> {
    const games = await this.mongo.games();
    const rows = await games
      .aggregate<{ _id: { racerId: string; dayKey: string }; n: number }>([
        { $unwind: '$results' },
        { $match: { 'results.place': 1 } },
        { $group: { _id: { racerId: '$results.racerId', dayKey: '$dayKey' }, n: { $sum: 1 } } },
      ])
      .toArray();

    const byUser = new Map<string, DayCounts>();
    for (const row of rows) {
      const days = byUser.get(row._id.racerId) ?? new Map<string, number>();
      days.set(row._id.dayKey, row.n);
      byUser.set(row._id.racerId, days);
    }
    return byUser;
  }

  // ── Scope maths ────────────────────────────────────────────────────────────

  /**
   * Per-metric values at each achievement scope, over the given races.
   *   all-time  aggregate every race
   *   daily     best single day
   *   monthly   best single month
   *   game      best single race
   * Formula metrics are folded in at each scope from the base totals.
   */
  private scopeMaps(
    rows: ParticipationRow[],
    registry: MetricRegistry,
    aggregationFor: (id: string) => MetricAggregation,
  ): Record<AchievementScope, Record<string, number>> {
    const baseIds = [
      'wins', 'podiums', 'races', 'gameScore', 'bestScore', 'avgPlace',
      ...registry.captured.map((m) => m.id),
    ];

    const bestByBucket = (bucket: (r: ParticipationRow) => string, id: string): number => {
      const groups = new Map<string, number[]>();
      for (const r of rows) {
        const key = bucket(r);
        const list = groups.get(key) ?? [];
        list.push(r.base[id] ?? 0);
        groups.set(key, list);
      }
      let best = 0;
      for (const values of groups.values()) best = Math.max(best, aggregate(values, aggregationFor(id)));
      return best;
    };

    const withFormulas = (baseMap: Record<string, number>): Record<string, number> => ({
      ...baseMap,
      ...this.metrics.computeFormulas(baseMap, registry.formulas),
    });

    const allTime: Record<string, number> = {};
    const daily: Record<string, number> = {};
    const monthly: Record<string, number> = {};
    const game: Record<string, number> = {};
    for (const id of baseIds) {
      allTime[id] = aggregate(rows.map((r) => r.base[id] ?? 0), aggregationFor(id));
      daily[id] = bestByBucket((r) => r.dayKey, id);
      monthly[id] = bestByBucket((r) => r.monthKey, id);
      game[id] = rows.reduce((max, r) => Math.max(max, r.base[id] ?? 0), 0);
    }

    return {
      'all-time': withFormulas(allTime),
      daily: withFormulas(daily),
      monthly: withFormulas(monthly),
      game: withFormulas(game),
    };
  }

  // ── Evaluation ──────────────────────────────────────────────────────────────

  private evaluate(input: {
    userId: string;
    chrono: ParticipationRow[];
    rules: AchievementRule[];
    registry: MetricRegistry;
    scope: Record<AchievementScope, Record<string, number>>;
    aggregationFor: (id: string) => MetricAggregation;
    streaks: StreakSummary;
    leaders: Map<string, Set<string>>;
    backToBackAt: string | null;
    monthlyLeader: boolean;
  }): AchievementState[] {
    const { userId, chrono, rules, registry, scope, aggregationFor, streaks, leaders, backToBackAt, monthlyLeader } = input;

    const winRowsChrono = chrono.filter((r) => r.place === 1);
    const leadDays = [...leaders.entries()].filter(([, ids]) => ids.has(userId)).map(([day]) => day);
    const monthsWon = new Set(winRowsChrono.map((r) => r.monthKey)).size;

    // ── Rules ──
    const ruleStates: AchievementState[] = rules.map((rule) => {
      const value = scope[rule.scope]?.[rule.metricId] ?? 0;
      const unit = registry.byId.get(rule.metricId)?.unit;
      const unlocked = value >= rule.threshold;
      return {
        id: rule.id,
        name: rule.name,
        description: rule.description,
        tier: rule.tier,
        icon: rule.icon,
        source: 'rule',
        unlocked,
        progress: rule.threshold <= 0 ? 1 : Math.min(1, value / rule.threshold),
        progressLabel: `${fmt(Math.min(value, rule.threshold))} / ${fmt(rule.threshold)}${unit ? ` ${unit}` : ''}`,
        unlockedAt: unlocked
          ? this.firstReached(chrono, rule.metricId, rule.scope, rule.threshold, registry, aggregationFor)
          : null,
      };
    });

    // ── Specials ──
    const happyWin = findFirst(winRowsChrono, (r) => {
      const m = minuteOfDay(r.at);
      return m >= HAPPY_HOUR_START && m < HAPPY_HOUR_END;
    });
    const comeback = findFirst(winRowsChrono, (win, i) => {
      const previous = winRowsChrono[i - 1];
      return previous ? dayKeyDiff(win.dayKey, previous.dayKey) > 7 : false;
    });

    const specialRules = [
      flag('happy_hour', Boolean(happyWin), happyWin ? 'Won during happy hour' : 'Not yet in the window', happyWin?.at.toISOString() ?? null),
      flag('back_to_back', Boolean(backToBackAt), backToBackAt ? '3 in a row, uninterrupted' : 'No triple yet', backToBackAt),
      count('streak_3', streaks.longestWinStreak, 3, 'day streak', null),
      count('streak_7', streaks.longestWinStreak, 7, 'day streak', null),
      count('streak_14', streaks.longestWinStreak, 14, 'day streak', null),
      count('lead_1', leadDays.length, 1, 'day at #1', null),
      count('lead_5', leadDays.length, 5, 'days at #1', null),
      count('lead_streak_3', streaks.longestDailyLeadStreak, 3, 'days running', null),
      count('all_rounder', monthsWon, 3, 'months', null),
      flag('monthly_monarch', monthlyLeader, monthlyLeader ? 'Holding #1' : 'Not #1 this month', null),
      flag('comeback', Boolean(comeback), comeback ? 'Returned in style' : 'No 7-day gap yet', comeback?.at.toISOString() ?? null),
    ];

    const byId = new Map(specialRules.map((rule) => [rule.id, rule]));
    const specialStates: AchievementState[] = SPECIALS.map((definition) => {
      const rule = byId.get(definition.id);
      return {
        ...definition,
        unlocked: rule?.unlocked ?? false,
        progress: rule?.progress ?? 0,
        progressLabel: rule?.progressLabel ?? '',
        unlockedAt: rule?.unlocked ? (rule?.unlockedAt ?? null) : null,
      };
    });

    return [...specialStates, ...ruleStates];
  }

  /**
   * The timestamp a rule first crossed its threshold, or null. Replays the
   * racer's races in chronological order and recomputes the scope value on each
   * growing prefix; scope values are monotonic as races are added, so the first
   * crossing is the unlock moment. Races are few, so the O(n²) replay is fine.
   */
  private firstReached(
    chrono: ParticipationRow[],
    metricId: string,
    scope: AchievementScope,
    threshold: number,
    registry: MetricRegistry,
    aggregationFor: (id: string) => MetricAggregation,
  ): string | null {
    for (let k = 1; k <= chrono.length; k += 1) {
      const maps = this.scopeMaps(chrono.slice(0, k), registry, aggregationFor);
      if ((maps[scope]?.[metricId] ?? 0) >= threshold) return chrono[k - 1].at.toISOString();
    }
    return null;
  }

  /**
   * Back-to-back: 3 wins in a row in one day, with no other racer winning in
   * between. Only days where this racer already has ≥3 wins can qualify, so we
   * fetch just those days' races, order them by time and look for a run of
   * three consecutive races all won by this racer. Returns the unlock timestamp
   * (the third race of the earliest run) or null.
   */
  private async resolveBackToBack(userId: string, myWinsByDay: DayCounts): Promise<string | null> {
    const candidateDays = [...myWinsByDay.entries()].filter(([, n]) => n >= 3).map(([day]) => day);
    if (candidateDays.length === 0) return null;

    const games = await this.mongo.games();
    const docs = await games
      .aggregate<{ at: Date; dayKey: string; winner: string | null }>([
        { $match: { dayKey: { $in: candidateDays } } },
        {
          $project: {
            at: 1,
            dayKey: 1,
            winner: {
              $arrayElemAt: [
                {
                  $map: {
                    input: { $filter: { input: '$results', as: 'r', cond: { $eq: ['$$r.place', 1] } } },
                    as: 'w',
                    in: '$$w.racerId',
                  },
                },
                0,
              ],
            },
          },
        },
        { $sort: { at: 1 } },
      ])
      .toArray();

    // Walk each day's ordered winners looking for a run of three by this racer.
    const byDay = new Map<string, Array<{ at: Date; winner: string | null }>>();
    for (const doc of docs) {
      const list = byDay.get(doc.dayKey) ?? [];
      list.push({ at: doc.at, winner: doc.winner });
      byDay.set(doc.dayKey, list);
    }

    let earliest: Date | null = null;
    for (const list of byDay.values()) {
      let run = 0;
      for (const race of list) {
        run = race.winner === userId ? run + 1 : 0;
        if (run >= 3) {
          if (!earliest || race.at < earliest) earliest = race.at;
          break;
        }
      }
    }
    return earliest ? earliest.toISOString() : null;
  }

  // ── Streak / leader helpers ────────────────────────────────────────────────

  private dailyLeaders(byUser: Map<string, DayCounts>): Map<string, Set<string>> {
    const totals = new Map<string, Map<string, number>>();
    for (const [userId, days] of byUser) {
      for (const [day, count] of days) {
        if (count <= 0) continue;
        if (!totals.has(day)) totals.set(day, new Map());
        totals.get(day)!.set(userId, count);
      }
    }
    const leaders = new Map<string, Set<string>>();
    for (const [day, perUser] of totals) {
      const best = Math.max(...perUser.values());
      const winners = new Set<string>();
      for (const [id, count] of perUser) if (count === best) winners.add(id);
      leaders.set(day, winners);
    }
    return leaders;
  }

  private computeStreaks(
    userId: string,
    myWinsByDay: DayCounts,
    leaders: Map<string, Set<string>>,
    rows: ParticipationRow[],
  ): StreakSummary {
    const winDays = [...myWinsByDay.keys()].sort();
    const leadDays = [...leaders.entries()]
      .filter(([, ids]) => ids.has(userId))
      .map(([day]) => day)
      .sort();
    const lastWin = rows.find((r) => r.place === 1);

    return {
      currentWinStreak: this.currentStreak(winDays),
      longestWinStreak: this.longestStreak(winDays),
      currentDailyLeadStreak: this.currentStreak(leadDays),
      longestDailyLeadStreak: this.longestStreak(leadDays),
      daysAsDailyLeader: leadDays.length,
      lastWinAt: lastWin?.at.toISOString() ?? null,
    };
  }

  private currentStreak(sortedDays: string[]): number {
    if (sortedDays.length === 0) return 0;
    const today = dayKey();
    const last = sortedDays[sortedDays.length - 1];
    if (dayKeyDiff(today, last) > 1) return 0;
    let streak = 1;
    for (let i = sortedDays.length - 1; i > 0; i -= 1) {
      if (dayKeyDiff(sortedDays[i], sortedDays[i - 1]) === 1) streak += 1;
      else break;
    }
    return streak;
  }

  private longestStreak(sortedDays: string[]): number {
    if (sortedDays.length === 0) return 0;
    let best = 1;
    let run = 1;
    for (let i = 1; i < sortedDays.length; i += 1) {
      if (dayKeyDiff(sortedDays[i], sortedDays[i - 1]) === 1) run += 1;
      else run = 1;
      if (run > best) best = run;
    }
    return best;
  }

  private rank(
    userId: string,
    scores: Map<string, { allTime: number; month: number; day: number }>,
    pick: (s: { allTime: number; month: number; day: number }) => number,
  ): number | null {
    const mine = scores.get(userId);
    if (!mine || pick(mine) <= 0) return null;
    let ahead = 0;
    for (const [id, s] of scores) if (id !== userId && pick(s) > pick(mine)) ahead += 1;
    return ahead + 1;
  }

  private isMonthlyLeader(
    userId: string,
    scores: Map<string, { allTime: number; month: number; day: number }>,
  ): boolean {
    const mine = scores.get(userId)?.month ?? 0;
    if (mine <= 0) return false;
    for (const s of scores.values()) if (s.month > mine) return false;
    return true;
  }

  private activityWindow(days: DayCounts, count: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const day of recentDayKeys(count)) out[day] = days.get(day) ?? 0;
    return out;
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function findFirst<T>(items: T[], predicate: (item: T, index: number) => boolean): T | undefined {
  for (let i = 0; i < items.length; i += 1) if (predicate(items[i], i)) return items[i];
  return undefined;
}

function count(id: string, value: number, goal: number, unit: string, unlockedAt: string | null) {
  return {
    id,
    unlocked: value >= goal,
    progress: Math.min(1, goal === 0 ? 1 : value / goal),
    progressLabel: `${Math.min(value, goal)} / ${goal} ${unit}`,
    unlockedAt,
  };
}

function flag(id: string, unlocked: boolean, label: string, unlockedAt: string | null) {
  return { id, unlocked, progress: unlocked ? 1 : 0, progressLabel: label, unlockedAt };
}
