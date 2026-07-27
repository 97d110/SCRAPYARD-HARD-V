import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { MongoService } from '../database/mongo.service';
import { ScoreboardRepository } from '../database/scoreboard.repository';
import type {
  AchievementDef,
  AchievementState,
  ProfileBundle,
  StreakSummary,
  WinEntry,
} from '@scrapyard/shared';
import { dayKey, dayKeyDiff, hourOfDay, recentDayKeys } from '../common/period.util';

/**
 * Achievements are entirely *derived* — nothing about them is stored. Adding,
 * retuning or removing a badge needs no migration.
 */
export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_blood', name: 'Ignition', description: 'Record your first win.', tier: 'bronze', icon: 'flame' },
  { id: 'wins_10', name: 'Scrap Collector', description: 'Reach 10 all-time wins.', tier: 'bronze', icon: 'boxes' },
  { id: 'wins_25', name: 'Scrap Baron', description: 'Reach 25 all-time wins.', tier: 'silver', icon: 'crown' },
  { id: 'wins_50', name: 'Track Tyrant', description: 'Reach 50 all-time wins.', tier: 'gold', icon: 'trophy' },
  { id: 'wins_100', name: 'Blaze Legend', description: 'Reach 100 all-time wins.', tier: 'plasma', icon: 'zap' },
  { id: 'hat_trick', name: 'Hat Trick', description: 'Win 3 races in a single day.', tier: 'bronze', icon: 'target' },
  { id: 'day_five', name: 'No Brakes', description: 'Win 5 races in a single day.', tier: 'silver', icon: 'gauge' },
  { id: 'day_ten', name: 'Rocket Bait', description: 'Win 10 races in a single day.', tier: 'gold', icon: 'rocket' },
  { id: 'streak_3', name: 'Three-Day Burn', description: 'Win on 3 consecutive days.', tier: 'bronze', icon: 'flame' },
  { id: 'streak_7', name: 'Perfect Week', description: 'Win on 7 consecutive days.', tier: 'gold', icon: 'calendar-check' },
  { id: 'streak_14', name: 'Unstoppable', description: 'Win on 14 consecutive days.', tier: 'plasma', icon: 'infinity' },
  { id: 'lead_1', name: 'Day Crown', description: 'Finish #1 on a daily leaderboard.', tier: 'bronze', icon: 'medal' },
  { id: 'lead_5', name: 'Serial Champion', description: 'Top the daily board on 5 different days.', tier: 'silver', icon: 'medal' },
  { id: 'lead_streak_3', name: 'Dynasty', description: 'Top the daily board 3 days running.', tier: 'gold', icon: 'swords' },
  { id: 'monthly_monarch', name: 'Monthly Monarch', description: 'Sit at #1 on the current monthly board.', tier: 'gold', icon: 'crown' },
  { id: 'night_rider', name: 'Good Evening!', description: 'Log a win between 22:00 and 04:00.', tier: 'silver', icon: 'moon' },
  { id: 'comeback', name: 'Comeback Kid', description: 'Win again after 7+ days away.', tier: 'silver', icon: 'undo' },
  { id: 'all_rounder', name: 'All-Round', description: 'Win in 3 different calendar months.', tier: 'gold', icon: 'globe' },
];

/** Per-day win counts, `YYYY-MM-DD` -> count. */
type DayCounts = Map<string, number>;

@Injectable()
export class AchievementsService {
  constructor(
    private readonly users: UsersService,
    private readonly mongo: MongoService,
    private readonly scoreboards: ScoreboardRepository,
  ) {}

  definitions(): AchievementDef[] {
    return ACHIEVEMENTS;
  }

  /** Everything the profile page needs, in one shot. */
  async buildProfile(userId: string): Promise<ProfileBundle> {
    const record = await this.users.requireRaw(userId);
    const wins = await this.mongo.wins();

    const [myDays, allDays, recentDocs, monthCount, scores] = await Promise.all([
      this.dayCountsFor(userId),
      this.dayCountsByUser(),
      // Wins are indexed on (userId, at), so this is a covered range scan.
      wins.find({ userId }).sort({ at: -1 }).limit(200).toArray(),
      wins.distinct('monthKey', { userId }),
      this.scoreboards.scoresByUser(),
    ]);

    const recentWins: WinEntry[] = recentDocs.map((doc) => ({
      id: doc._id,
      userId: doc.userId,
      at: doc.at.toISOString(),
      monthKey: doc.monthKey,
      dayKey: doc.dayKey,
      awardedBy: doc.awardedBy,
      ...(doc.note ? { note: doc.note } : {}),
    }));

    const leaders = this.dailyLeaders(allDays);
    const streaks = this.computeStreaks(userId, myDays, leaders, recentWins);
    const mine = scores.get(userId);
    const allTime = mine?.allTime ?? 0;

    return {
      user: this.users.toPublic(record, mine),
      streaks,
      achievements: this.evaluate({
        allTime,
        dayCounts: myDays,
        monthsWon: monthCount.length,
        recentWins,
        streaks,
        monthlyLeader: this.isMonthlyLeader(userId, scores),
      }),
      ranks: {
        allTime: this.rank(userId, scores, (s) => s.allTime),
        monthly: this.rank(userId, scores, (s) => s.month),
        daily: this.rank(userId, scores, (s) => s.day),
      },
      recentWins: recentWins.slice(0, 25),
      activity: this.activityWindow(myDays, 90),
    };
  }

  /**
   * One racer's wins grouped by day.
   *
   * The (userId, dayKey) index makes this a covered aggregation — Mongo answers
   * it from the index without reading any documents.
   */
  private async dayCountsFor(userId: string): Promise<DayCounts> {
    const wins = await this.mongo.wins();
    const rows = await wins
      .aggregate<{ _id: string; n: number }>([
        { $match: { userId } },
        { $group: { _id: '$dayKey', n: { $sum: 1 } } },
      ])
      .toArray();
    return new Map(rows.map((r) => [r._id, r.n]));
  }

  /** Every racer's wins grouped by day — needed to work out who led each day. */
  private async dayCountsByUser(): Promise<Map<string, DayCounts>> {
    const wins = await this.mongo.wins();
    const rows = await wins
      .aggregate<{ _id: { userId: string; dayKey: string }; n: number }>([
        { $group: { _id: { userId: '$userId', dayKey: '$dayKey' }, n: { $sum: 1 } } },
      ])
      .toArray();

    const byUser = new Map<string, DayCounts>();
    for (const row of rows) {
      const days = byUser.get(row._id.userId) ?? new Map<string, number>();
      days.set(row._id.dayKey, row.n);
      byUser.set(row._id.userId, days);
    }
    return byUser;
  }

  /** 'YYYY-MM-DD' -> the set of racers who tied for #1 that day. */
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
    myDays: DayCounts,
    leaders: Map<string, Set<string>>,
    recentWins: WinEntry[],
  ): StreakSummary {
    const winDays = [...myDays.keys()].sort();
    const leadDays = [...leaders.entries()]
      .filter(([, ids]) => ids.has(userId))
      .map(([day]) => day)
      .sort();

    return {
      currentWinStreak: this.currentStreak(winDays),
      longestWinStreak: this.longestStreak(winDays),
      currentDailyLeadStreak: this.currentStreak(leadDays),
      longestDailyLeadStreak: this.longestStreak(leadDays),
      daysAsDailyLeader: leadDays.length,
      lastWinAt: recentWins[0]?.at ?? null,
    };
  }

  /**
   * A streak stays alive if the most recent day is today or yesterday — you
   * shouldn't lose it just because today's race hasn't happened yet.
   */
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

  private evaluate(input: {
    allTime: number;
    dayCounts: DayCounts;
    monthsWon: number;
    recentWins: WinEntry[];
    streaks: StreakSummary;
    monthlyLeader: boolean;
  }): AchievementState[] {
    const { allTime, dayCounts, monthsWon, recentWins, streaks, monthlyLeader } = input;
    const bestDay = dayCounts.size === 0 ? 0 : Math.max(...dayCounts.values());

    /*
     * recentWins is newest-first and capped at 200. `findLast` therefore returns
     * the *oldest* qualifying win in the window, which is the one that actually
     * unlocked the badge.
     */
    const nightWin = findLast(recentWins, (win) => {
      const hour = hourOfDay(new Date(win.at));
      return hour >= 22 || hour < 4;
    });

    const comeback = findLast(recentWins, (win, position) => {
      const previous = recentWins[position + 1];
      return previous ? dayKeyDiff(win.dayKey, previous.dayKey) > 7 : false;
    });

    /*
     * The win log is capped at 200 for this calculation, so once a racer passes
     * that we can no longer identify their nth win. Better to report no
     * timestamp than confidently point at the wrong one.
     */
    const logIsComplete = recentWins.length === allTime;
    const nthWinAt = (n: number): string | null => {
      if (!logIsComplete) return null;
      const index = recentWins.length - n;
      return index >= 0 ? recentWins[index].at : null;
    };

    const rules = [
      count('first_blood', allTime, 1, 'win', nthWinAt(1)),
      count('wins_10', allTime, 10, 'wins', nthWinAt(10)),
      count('wins_25', allTime, 25, 'wins', nthWinAt(25)),
      count('wins_50', allTime, 50, 'wins', nthWinAt(50)),
      count('wins_100', allTime, 100, 'wins', nthWinAt(100)),
      count('hat_trick', bestDay, 3, 'in a day', null),
      count('day_five', bestDay, 5, 'in a day', null),
      count('day_ten', bestDay, 10, 'in a day', null),
      count('streak_3', streaks.longestWinStreak, 3, 'day streak', null),
      count('streak_7', streaks.longestWinStreak, 7, 'day streak', null),
      count('streak_14', streaks.longestWinStreak, 14, 'day streak', null),
      count('lead_1', streaks.daysAsDailyLeader, 1, 'day at #1', null),
      count('lead_5', streaks.daysAsDailyLeader, 5, 'days at #1', null),
      count('lead_streak_3', streaks.longestDailyLeadStreak, 3, 'days running', null),
      count('all_rounder', monthsWon, 3, 'months', null),
      flag('monthly_monarch', monthlyLeader, monthlyLeader ? 'Holding #1' : 'Not #1 this month', null),
      flag('night_rider', Boolean(nightWin), nightWin ? 'Logged after dark' : 'No late-night wins', nightWin?.at ?? null),
      flag('comeback', Boolean(comeback), comeback ? 'Returned in style' : 'No 7-day gap yet', comeback?.at ?? null),
    ];

    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    return ACHIEVEMENTS.map((definition) => {
      const rule = byId.get(definition.id);
      return {
        ...definition,
        unlocked: rule?.unlocked ?? false,
        progress: rule?.progress ?? 0,
        progressLabel: rule?.progressLabel ?? '',
        unlockedAt: rule?.unlocked ? (rule?.unlockedAt ?? null) : null,
      };
    });
  }
}

/** Array.prototype.findLast, without requiring the ES2023 lib. */
function findLast<T>(items: T[], predicate: (item: T, index: number) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i], i)) return items[i];
  }
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
