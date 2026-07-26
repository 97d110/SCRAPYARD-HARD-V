/**
 * Seeds the JSON database with demo racers and a scatter of wins, so the
 * leaderboard, streaks and achievements have something to show before real
 * SSO users exist.
 *
 *   npm run seed
 *
 * Seeded ids are prefixed `seed-`, so they're easy to spot and delete:
 *   rm apps/api/database/users/seed-*.json && curl -XPOST .../scores/rebuild?confirm=yes
 */
import { randomUUID } from 'crypto';
import { JsonStoreService } from './json-store.service';
import { IndexService } from './index.service';
import type { UserRecord, WinEntry } from '@scrapyard/shared';
import { dayKey, monthKey, shiftDayKey } from '../common/period.util';
import { ACCENT_COLORS, RACERS } from '../users/users.service';
import { ContentService } from '../content/content.service';

const DOMAIN = (process.env.ALLOWED_WORKSPACE_DOMAINS ?? 'cytactic.com')
  .split(',')[0]
  .trim();

interface SeedSpec {
  slug: string;
  name: string;
  tagline: string;
  /** [daysAgo, wins] pairs. */
  pattern: Array<[number, number]>;
  role?: 'admin' | 'racer';
}

const SEEDS: SeedSpec[] = [
  {
    slug: 'amit',
    name: 'Amit Nino',
    tagline: 'Ships code, ships Arthur, ships everyone off the track.',
    role: 'admin',
    // A live 6-day streak plus a heavy back catalogue.
    pattern: [[0, 3], [1, 2], [2, 4], [3, 1], [4, 2], [5, 3], [9, 2], [12, 1], [18, 4], [24, 2], [31, 3], [40, 2], [55, 1]],
  },
  {
    slug: 'dana',
    name: 'Dana Kessler',
    tagline: 'Brakes? In this economy?',
    pattern: [[0, 4], [1, 1], [3, 2], [4, 3], [6, 1], [8, 2], [15, 3], [22, 1], [29, 2], [44, 1]],
  },
  {
    slug: 'noam',
    name: 'Noam Barak',
    tagline: 'Professional mine-avoider. Amateur mine-finder.',
    pattern: [[0, 1], [2, 2], [5, 1], [7, 4], [11, 2], [16, 1], [20, 3], [33, 2]],
  },
  {
    slug: 'yael',
    name: 'Yael Doron',
    tagline: 'Drifts on ice, thrives on chaos.',
    pattern: [[1, 3], [2, 1], [4, 2], [9, 5], [13, 1], [19, 2], [26, 3], [38, 1], [50, 2]],
  },
  {
    slug: 'omer',
    name: 'Omer Ziv',
    tagline: 'The rocket and I are on a first-name basis.',
    pattern: [[0, 2], [6, 1], [10, 2], [14, 1], [21, 4], [30, 1], [47, 2]],
  },
  {
    slug: 'lior',
    name: 'Lior Shani',
    tagline: 'Last place is just first place from the other end.',
    pattern: [[3, 1], [8, 1], [17, 2], [28, 1], [41, 1]],
  },
  {
    slug: 'tamar',
    name: 'Tamar Peled',
    tagline: 'Chain lightning enthusiast.',
    pattern: [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 2], [23, 3]],
  },
  {
    slug: 'gil',
    name: 'Gil Avraham',
    tagline: 'New to the yard. Already dangerous.',
    pattern: [[0, 1], [2, 1]],
  },
];

function buildUser(spec: SeedSpec, position: number): UserRecord {
  const id = `seed-${spec.slug}`;
  const today = dayKey();
  const wins: WinEntry[] = [];
  const daily: Record<string, number> = {};
  const monthly: Record<string, number> = {};

  for (const [daysAgo, count] of spec.pattern) {
    const day = shiftDayKey(today, -daysAgo);
    const month = day.slice(0, 7);
    daily[day] = (daily[day] ?? 0) + count;
    monthly[month] = (monthly[month] ?? 0) + count;

    for (let i = 0; i < count; i += 1) {
      // Spread wins across the evening; one lands after 22:00 for Good evening!
      const hour = 17 + ((position + i + daysAgo) % 7);
      wins.push({
        id: randomUUID(),
        at: new Date(`${day}T${String(hour).padStart(2, '0')}:${String((i * 17) % 60).padStart(2, '0')}:00.000Z`).toISOString(),
        monthKey: month,
        dayKey: day,
        awardedBy: 'seed-amit',
      });
    }
  }

  // Newest first, matching how the API stores them.
  wins.sort((a, b) => b.at.localeCompare(a.at));
  const allTime = Object.values(daily).reduce((sum, n) => sum + n, 0);
  const createdAt = new Date(Date.now() - (90 - position) * 86_400_000).toISOString();

  return {
    id,
    googleId: id,
    email: `${spec.slug}@${DOMAIN}`,
    domain: DOMAIN,
    role: spec.role ?? 'racer',
    googleFullName: spec.name,
    googleAvatarUrl: '',
    displayName: spec.name,
    avatarUrl: '',
    tagline: spec.tagline,
    favoriteRacer: RACERS[position % RACERS.length],
    accentColor: ACCENT_COLORS[position % ACCENT_COLORS.length],
    createdAt,
    updatedAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
    scores: { allTime, monthly, daily },
    wins,
  };
}

async function main(): Promise<void> {
  const store = new JsonStoreService();
  const index = new IndexService(store);
  const content = new ContentService(store, index);

  await store.ensureLayout();
  await content.onModuleInit();

  const users = SEEDS.map(buildUser);
  for (const user of users) {
    await store.write(`users/${user.id}.json`, user);
  }

  // Rebuild every derived board from the freshly written user files.
  const months = new Set<string>([monthKey()]);
  const days = new Set<string>([dayKey()]);
  for (const user of users) {
    Object.keys(user.scores.monthly).forEach((key) => months.add(key));
    Object.keys(user.scores.daily).forEach((key) => days.add(key));
  }

  const build = (kind: 'all-time' | 'monthly' | 'daily', key: string) => {
    const pointsOf = (user: UserRecord): number =>
      kind === 'all-time'
        ? user.scores.allTime
        : kind === 'monthly'
          ? (user.scores.monthly[key] ?? 0)
          : (user.scores.daily[key] ?? 0);

    const ranked = [...users]
      .map((user) => ({ user, points: pointsOf(user) }))
      .sort((a, b) => b.points - a.points || a.user.displayName.localeCompare(b.user.displayName));

    let lastPoints: number | null = null;
    let lastRank = 0;
    const entries = ranked.map((row, i) => {
      const tied = lastPoints === row.points;
      const rank = tied ? lastRank : i + 1;
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
      label: kind === 'all-time' ? 'All Time' : key,
      generatedAt: new Date().toISOString(),
      totalPoints: entries.reduce((sum, e) => sum + e.points, 0),
      entries,
    };
  };

  await store.write('scores/all-time.json', build('all-time', 'all-time'));
  for (const key of months) await store.write(`scores/monthly-${key}.json`, build('monthly', key));
  for (const key of days) await store.write(`scores/daily-${key}.json`, build('daily', key));

  const written = await index.rebuild();

  console.log(`Seeded ${users.length} racers.`);
  console.log(`Scoreboards: ${written.counts.scoreboards}`);
  console.log(`Database root: ${store.rootDir}`);
  console.log('\nNote: seeded users cannot sign in — they have no real Google account.');
  console.log('Remove them with: rm apps/api/database/users/seed-*.json');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
