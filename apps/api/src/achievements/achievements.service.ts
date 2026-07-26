import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import type {
  AchievementDef,
  AchievementState,
  ProfileBundle,
  StreakSummary,
  UserRecord,
} from '@scrapyard/shared';
import { dayKey, dayKeyDiff, hourOfDay, monthKey, recentDayKeys } from '../common/period.util';

/**
 * Achievements are entirely *derived* from the user files — nothing is stored.
 * That means we can add, retune or remove a badge without a migration, which
 * is the whole point of going lo-fi.
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

@Injectable()
export class AchievementsService {
  constructor(private readonly users: UsersService) {}

  definitions(): AchievementDef[] {
    return ACHIEVEMENTS;
  }

  /** Everything the profile page needs, in one shot. */
  async buildProfile(userId: string): Promise<ProfileBundle> {
    const all = await this.users.findAllRaw();
    const user = all.find((candidate) => candidate.id === userId) ?? (await this.users.requireRaw(userId));

    const leaders = this.dailyLeadersByDay(all);
    const streaks = this.computeStreaks(user, leaders);

    return {
      user: this.users.toPublic(user),
      streaks,
      achievements: this.evaluate(user, streaks, all),
      ranks: {
        allTime: this.rankOf(user, all, (candidate) => candidate.scores.allTime),
        monthly: this.rankOf(user, all, (candidate) => candidate.scores.monthly[monthKey()] ?? 0),
        daily: this.rankOf(user, all, (candidate) => candidate.scores.daily[dayKey()] ?? 0),
      },
      recentWins: user.wins.slice(0, 25),
      activity: this.activityWindow(user, 90),
    };
  }

  /** 'YYYY-MM-DD' -> set of user ids that tied for #1 that day. */
  private dailyLeadersByDay(all: UserRecord[]): Map<string, Set<string>> {
    const totals = new Map<string, Map<string, number>>();

    for (const user of all) {
      for (const [day, points] of Object.entries(user.scores.daily)) {
        if (points <= 0) continue;
        if (!totals.has(day)) totals.set(day, new Map());
        totals.get(day)!.set(user.id, points);
      }
    }

    const leaders = new Map<string, Set<string>>();
    for (const [day, byUser] of totals) {
      const best = Math.max(...byUser.values());
      const winners = new Set<string>();
      for (const [id, points] of byUser) {
        if (points === best) winners.add(id);
      }
      leaders.set(day, winners);
    }
    return leaders;
  }

  private computeStreaks(user: UserRecord, leaders: Map<string, Set<string>>): StreakSummary {
    const winDays = Object.entries(user.scores.daily)
      .filter(([, points]) => points > 0)
      .map(([day]) => day)
      .sort();

    const leadDays = [...leaders.entries()]
      .filter(([, ids]) => ids.has(user.id))
      .map(([day]) => day)
      .sort();

    return {
      currentWinStreak: this.currentStreak(winDays),
      longestWinStreak: this.longestStreak(winDays),
      currentDailyLeadStreak: this.currentStreak(leadDays),
      longestDailyLeadStreak: this.longestStreak(leadDays),
      daysAsDailyLeader: leadDays.length,
      lastWinAt: user.wins[0]?.at ?? null,
    };
  }

  /**
   * A streak stays "alive" if the most recent day is today or yesterday —
   * you shouldn't lose your streak just because today's race hasn't happened.
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

  private rankOf(
    user: UserRecord,
    all: UserRecord[],
    pointsOf: (user: UserRecord) => number,
  ): number | null {
    const mine = pointsOf(user);
    if (mine <= 0) return null;
    const ahead = all.filter((candidate) => pointsOf(candidate) > mine).length;
    return ahead + 1;
  }

  private activityWindow(user: UserRecord, days: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const day of recentDayKeys(days)) {
      out[day] = user.scores.daily[day] ?? 0;
    }
    return out;
  }

  private evaluate(
    user: UserRecord,
    streaks: StreakSummary,
    all: UserRecord[],
  ): AchievementState[] {
    const allTime = user.scores.allTime;
    const bestDay = Math.max(0, ...Object.values(user.scores.daily));
    const monthsWon = Object.values(user.scores.monthly).filter((n) => n > 0).length;

    /*
     * Wins are stored newest-first. `findLast` therefore gives us the *oldest*
     * qualifying win, which is the one that actually unlocked the badge — the
     * same semantics as the nthWinAt-based rules below.
     *
     * The hour must come from the configured timezone, not the server's clock,
     * so "after dark" agrees with where the day boundary falls.
     */
    const nightWin = findLast(user.wins, (win) => {
      const hour = hourOfDay(new Date(win.at));
      return hour >= 22 || hour < 4;
    });

    // Walk pairs looking for a gap of more than 7 days between consecutive wins.
    const comeback = findLast(user.wins, (win, position) => {
      const previous = user.wins[position + 1];
      return previous ? dayKeyDiff(win.dayKey, previous.dayKey) > 7 : false;
    });

    const month = monthKey();
    const myMonthly = user.scores.monthly[month] ?? 0;
    const monthlyLeader =
      myMonthly > 0 && all.every((candidate) => (candidate.scores.monthly[month] ?? 0) <= myMonthly);

    /*
     * Timestamp of the nth win overall. wins[] is newest-first, so the nth win
     * sits at index length - n.
     *
     * The log is capped at 1000 entries (see ScoresService), so once a racer
     * passes that the tail is gone and the nth win is no longer recoverable —
     * we return null rather than confidently pointing at the wrong win.
     */
    const logIsComplete = user.wins.length === allTime;
    const nthWinAt = (n: number): string | null => {
      if (!logIsComplete) return null;
      const index = user.wins.length - n;
      return index >= 0 ? user.wins[index].at : null;
    };

    const rules: Array<{
      id: string;
      unlocked: boolean;
      progress: number;
      progressLabel: string;
      unlockedAt: string | null;
    }> = [
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

function count(
  id: string,
  value: number,
  goal: number,
  unit: string,
  unlockedAt: string | null,
) {
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
