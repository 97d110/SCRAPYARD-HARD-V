/**
 * Seeds MongoDB with demo racers and a scatter of wins, so the leaderboard,
 * streaks and achievements have something to show before real SSO users exist.
 *
 *   MONGODB_URI="mongodb+srv://..." npm run seed
 *
 * Seeded ids are prefixed `seed-`, so they're easy to spot and remove:
 *   db.users.deleteMany({ _id: /^seed-/ })
 *   db.wins.deleteMany({ userId: /^seed-/ })
 *
 * Re-running is safe: seeded racers and their wins are cleared first, and
 * nothing else is touched.
 */
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import type { UserDoc, WinDoc } from './mongo.service';
import { dayKey, shiftDayKey } from '../common/period.util';
import { ACCENT_COLORS, RACERS } from '../users/users.service';
import { DEFAULT_PUNS } from '../content/content.service';

const DOMAIN = (process.env.ALLOWED_WORKSPACE_DOMAINS ?? 'cytactic.com').split(',')[0].trim();

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

function buildUser(spec: SeedSpec, position: number): UserDoc {
  const id = `seed-${spec.slug}`;
  const now = new Date().toISOString();
  return {
    _id: id,
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
    createdAt: new Date(Date.now() - (90 - position) * 86_400_000).toISOString(),
    updatedAt: now,
    lastLoginAt: now,
  };
}

function buildWins(spec: SeedSpec, position: number): WinDoc[] {
  const id = `seed-${spec.slug}`;
  const today = dayKey();
  const out: WinDoc[] = [];

  for (const [daysAgo, count] of spec.pattern) {
    const day = shiftDayKey(today, -daysAgo);
    for (let i = 0; i < count; i += 1) {
      // Spread across the evening; one lands after 22:00 for "Good evening!".
      const hour = 17 + ((position + i + daysAgo) % 7);
      const minute = (i * 17) % 60;
      out.push({
        _id: randomUUID(),
        userId: id,
        at: new Date(
          `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`,
        ),
        monthKey: day.slice(0, 7),
        dayKey: day,
        awardedBy: 'seed-amit',
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Point it at your Atlas cluster or a local mongod.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'scrapyard');

  const users = db.collection<UserDoc>('users');
  const wins = db.collection<WinDoc>('wins');
  const content = db.collection('content');

  // Idempotent: clear only what a previous seed created.
  await users.deleteMany({ _id: { $regex: '^seed-' } });
  await wins.deleteMany({ userId: { $regex: '^seed-' } });

  const userDocs = SEEDS.map(buildUser);
  const winDocs = SEEDS.flatMap(buildWins);

  await users.insertMany(userDocs);
  await wins.insertMany(winDocs);

  // Puns, only if the document doesn't exist yet.
  const now = new Date().toISOString();
  await content.updateOne(
    { _id: 'puns' as never },
    {
      $setOnInsert: {
        label: 'Banner Puns',
        updatedAt: now,
        items: DEFAULT_PUNS.map((text) => ({
          id: randomUUID(),
          text,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        })),
      },
    },
    { upsert: true },
  );

  console.log(`Seeded ${userDocs.length} racers and ${winDocs.length} wins.`);
  console.log(`Database: ${db.databaseName}`);
  console.log('\nNote: seeded racers cannot sign in — they have no real Google account.');
  console.log("Remove them with: db.users.deleteMany({_id:/^seed-/}); db.wins.deleteMany({userId:/^seed-/})");

  await client.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
