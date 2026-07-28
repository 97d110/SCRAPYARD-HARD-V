/**
 * Seeds MongoDB with demo racers, full multi-racer games, a starter set of
 * metrics + a formula scoring system, and rule-based achievements — so the
 * leaderboards, profiles and admin editors all have something to show before
 * real SSO users exist.
 *
 *   MONGODB_URI="mongodb+srv://..." npm run seed
 *
 * Seeded racers are prefixed `seed-`, seeded rules `seed-`, and the starter
 * metrics have fixed ids (kills, deaths, combat). Re-running is safe: the seed
 * clears exactly what a previous run created and nothing else.
 *
 *   db.users.deleteMany({ _id: /^seed-/ })
 *   db.games.deleteMany({ 'results.racerId': /^seed-/ })
 *   db.achievementRules.deleteMany({ _id: /^seed-/ })
 *   db.metrics.deleteMany({ _id: { $in: ['kills','deaths','combat'] } })
 */
// Load apps/api/.env first so `npm run seed` works without inlining env vars.
import '../common/load-env';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import type { UserDoc, GameDoc, MetricDoc, AchievementRuleDoc } from './mongo.service';
import { ACCENT_COLORS, RACERS } from '../users/users.service';
import { DEFAULT_PUNS } from '../content/content.service';
import { killDerivedStats, tagRevengeSameDay, type KillPair } from '../common/kills';
import { blindIndex, encryptField } from '../common/crypto';

// Derive a plain domain for seeded emails from the first allowlist entry —
// which may be a bare domain (`cytactic.com`) or a glob (`*@cytactic.com`).
const FIRST_ENTRY = (process.env.ALLOWED_WORKSPACE_DOMAINS ?? 'cytactic.com')
  .split(',')[0]
  .trim()
  .toLowerCase();
const DOMAIN = (FIRST_ENTRY.includes('@') ? FIRST_ENTRY.slice(FIRST_ENTRY.lastIndexOf('@') + 1) : FIRST_ENTRY)
  .replace(/^\*\./, '')
  .replace(/\*/g, 'x');

interface SeedSpec {
  slug: string;
  name: string;
  tagline: string;
  role?: 'admin' | 'racer';
}

const SEEDS: SeedSpec[] = [
  { slug: 'amit', name: 'Amit Nino', tagline: 'Ships code, ships Arthur, ships everyone off the track.', role: 'admin' },
  { slug: 'dana', name: 'Dana Kessler', tagline: 'Brakes? In this economy?' },
  { slug: 'noam', name: 'Noam Barak', tagline: 'Professional mine-avoider. Amateur mine-finder.' },
  { slug: 'yael', name: 'Yael Doron', tagline: 'Drifts on ice, thrives on chaos.' },
  { slug: 'omer', name: 'Omer Ziv', tagline: 'The rocket and I are on a first-name basis.' },
  { slug: 'lior', name: 'Lior Shani', tagline: 'Last place is just first place from the other end.' },
  { slug: 'tamar', name: 'Tamar Peled', tagline: 'Chain lightning enthusiast.' },
  { slug: 'gil', name: 'Gil Avraham', tagline: 'New to the yard. Already dangerous.' },
];

const id = (slug: string) => `seed-${slug}`;

/**
 * The race schedule. Each entry is a day (days ago) and its races; a race is an
 * ordered list of racer slugs, winner first. Crafted so the coded specials
 * light up for Amit: a 6-day win streak (days 0–5), five wins on day 0 (Hat
 * Trick / No Brakes), the first three of those consecutive and uninterrupted
 * (Back-to-Back), all inside the 16:30–19:00 Happy Hour window.
 */
const SCHEDULE: Array<{ daysAgo: number; races: string[][] }> = [
  { daysAgo: 0, races: [
    ['amit', 'dana', 'noam', 'yael'],
    ['amit', 'omer', 'lior'],
    ['amit', 'tamar', 'gil', 'dana'],
    ['amit', 'noam', 'omer'],
    ['amit', 'yael', 'dana', 'lior'],
  ] },
  { daysAgo: 1, races: [['amit', 'dana', 'noam'], ['dana', 'amit', 'yael', 'omer']] },
  { daysAgo: 2, races: [['amit', 'noam', 'gil'], ['yael', 'tamar', 'amit']] },
  { daysAgo: 3, races: [['amit', 'omer', 'dana', 'noam']] },
  { daysAgo: 4, races: [['amit', 'lior', 'tamar'], ['omer', 'amit', 'gil']] },
  { daysAgo: 5, races: [['amit', 'dana', 'yael', 'noam']] },
  { daysAgo: 7, races: [['dana', 'noam', 'omer'], ['yael', 'dana', 'tamar', 'gil']] },
  { daysAgo: 9, races: [['amit', 'yael', 'lior'], ['noam', 'amit', 'omer', 'dana']] },
  { daysAgo: 12, races: [['dana', 'tamar', 'gil'], ['amit', 'dana', 'noam', 'yael']] },
  { daysAgo: 15, races: [['omer', 'lior', 'amit'], ['yael', 'noam', 'dana']] },
  { daysAgo: 18, races: [['amit', 'dana', 'omer', 'tamar'], ['amit', 'noam', 'gil']] },
  { daysAgo: 22, races: [['dana', 'amit', 'yael'], ['noam', 'omer', 'lior', 'gil']] },
  { daysAgo: 26, races: [['yael', 'dana', 'amit', 'noam']] },
  { daysAgo: 31, races: [['amit', 'omer', 'dana'], ['tamar', 'gil', 'noam', 'yael']] },
  { daysAgo: 38, races: [['dana', 'noam', 'amit'], ['amit', 'yael', 'omer', 'lior']] },
  { daysAgo: 45, races: [['omer', 'amit', 'dana', 'gil']] },
  { daysAgo: 55, races: [['amit', 'dana', 'noam', 'yael']] },
];

const SEED_METRICS: MetricDoc[] = [
  { _id: 'kills', label: 'Kills', icon: 'crosshair', unit: 'kills', description: 'Racers taken out with weapons.', kind: 'captured', aggregation: 'sum', order: 100, enabled: true, createdAt: '', updatedAt: '' },
  { _id: 'deaths', label: 'Deaths', icon: 'skull', unit: 'deaths', description: 'Times wrecked or blown up.', kind: 'captured', aggregation: 'sum', order: 101, enabled: true, createdAt: '', updatedAt: '' },
  { _id: 'combat', label: 'Combat', icon: 'swords', unit: 'pts', description: 'Aggression score: 2 per kill, −1 per death.', kind: 'formula', aggregation: 'sum', formula: [{ metricId: 'kills', weight: 2 }, { metricId: 'deaths', weight: -1 }], order: 200, enabled: true, createdAt: '', updatedAt: '' },
];

const SEED_RULES: Array<Omit<AchievementRuleDoc, 'createdAt' | 'updatedAt'>> = [
  { _id: 'seed-first_blood', name: 'Ignition', description: 'Record your first win.', tier: 'bronze', icon: 'flame', metricId: 'wins', scope: 'all-time', threshold: 1, order: 300, enabled: true },
  { _id: 'seed-wins_10', name: 'Scrap Collector', description: 'Reach 10 all-time wins.', tier: 'bronze', icon: 'boxes', metricId: 'wins', scope: 'all-time', threshold: 10, order: 301, enabled: true },
  { _id: 'seed-wins_25', name: 'Scrap Baron', description: 'Reach 25 all-time wins.', tier: 'silver', icon: 'crown', metricId: 'wins', scope: 'all-time', threshold: 25, order: 302, enabled: true },
  { _id: 'seed-wins_50', name: 'Track Tyrant', description: 'Reach 50 all-time wins.', tier: 'gold', icon: 'trophy', metricId: 'wins', scope: 'all-time', threshold: 50, order: 303, enabled: true },
  { _id: 'seed-wins_100', name: 'Blaze Legend', description: 'Reach 100 all-time wins.', tier: 'plasma', icon: 'zap', metricId: 'wins', scope: 'all-time', threshold: 100, order: 304, enabled: true },
  { _id: 'seed-day_one', name: 'On the Board', description: 'Win a race in a single day.', tier: 'bronze', icon: 'flag', metricId: 'wins', scope: 'daily', threshold: 1, order: 305, enabled: true },
  { _id: 'seed-hat_trick', name: 'Hat Trick', description: 'Win 3 races in a single day.', tier: 'bronze', icon: 'target', metricId: 'wins', scope: 'daily', threshold: 3, order: 306, enabled: true },
  { _id: 'seed-day_five', name: 'No Brakes', description: 'Win 5 races in a single day.', tier: 'silver', icon: 'gauge', metricId: 'wins', scope: 'daily', threshold: 5, order: 307, enabled: true },
  { _id: 'seed-day_ten', name: 'Rocket Bait', description: 'Win 10 races in a single day.', tier: 'gold', icon: 'rocket', metricId: 'wins', scope: 'daily', threshold: 10, order: 308, enabled: true },
  { _id: 'seed-score_250', name: 'Score Machine', description: 'Reach 250 all-time in-game score.', tier: 'silver', icon: 'gauge', metricId: 'gameScore', scope: 'all-time', threshold: 250, order: 309, enabled: true },
  { _id: 'seed-podium_25', name: 'Ever-Present', description: 'Reach 25 all-time podiums.', tier: 'silver', icon: 'medal', metricId: 'podiums', scope: 'all-time', threshold: 25, order: 310, enabled: true },
  { _id: 'seed-sharpshooter', name: 'Sharpshooter', description: 'Score 5 kills in a single race.', tier: 'gold', icon: 'crosshair', metricId: 'kills', scope: 'game', threshold: 5, order: 311, enabled: true },
  { _id: 'seed-executioner', name: 'Executioner', description: 'Reach 50 all-time kills.', tier: 'gold', icon: 'skull', metricId: 'kills', scope: 'all-time', threshold: 50, order: 312, enabled: true },
];

function buildUser(spec: SeedSpec, position: number): UserDoc {
  const now = new Date().toISOString();
  const googleId = id(spec.slug);
  const email = `${spec.slug}@${DOMAIN}`;
  return {
    _id: id(spec.slug),
    googleIdEnc: encryptField(googleId),
    googleIdHash: blindIndex(googleId),
    emailEnc: encryptField(email),
    emailHash: blindIndex(email),
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

/** N-th day ago as a 'YYYY-MM-DD' key (UTC). */
function dayKeyAgo(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

const SCORE_BY_PLACE: Record<number, number> = { 1: 15, 2: 12, 3: 8, 4: 4 };

/**
 * A plausible kill log for one race, deterministic from `salt`. Includes the
 * occasional "upset" (a lower place taking out the winner), which seeds a
 * same-day grudge that a later race can avenge — so the demo has real revenge.
 */
function killPairs(order: string[], salt: number): KillPair[] {
  const ids = order.map(id);
  const n = ids.length;
  const pairs: KillPair[] = [];
  if (n >= 2) pairs.push({ killerId: ids[0], victimId: ids[n - 1] }); // winner takes out last
  if (n >= 3 && salt % 2 === 0) pairs.push({ killerId: ids[1], victimId: ids[2] });
  if (n >= 3 && salt % 3 === 0) pairs.push({ killerId: ids[n - 1], victimId: ids[0] }); // upset → grudge
  if (n >= 4 && salt % 2 === 1) pairs.push({ killerId: ids[2], victimId: ids[3] });
  return pairs;
}

function buildGames(): GameDoc[] {
  const out: GameDoc[] = [];
  for (const { daysAgo, races } of SCHEDULE) {
    const day = dayKeyAgo(daysAgo);
    // Same-day grudge ledger accumulates across the day's races, in order.
    const priorPairs: KillPair[] = [];
    races.forEach((order, i) => {
      // 17:00, 17:25, 17:50, 18:15, 18:40 — all inside the Happy Hour window.
      const minutes = 17 * 60 + i * 25;
      const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
      const mm = String(minutes % 60).padStart(2, '0');
      const salt = daysAgo + i;

      const pairs = killPairs(order, salt);
      const events = tagRevengeSameDay(priorPairs, pairs);
      priorPairs.push(...pairs);

      const derived = killDerivedStats(pairs);
      const results = order.map((slug, idx) => {
        const place = idx + 1;
        const d = derived.get(id(slug)) ?? { kills: 0, deaths: 0 };
        return {
          racerId: id(slug),
          place,
          gameScore: Math.max(0, SCORE_BY_PLACE[place] + ((salt % 3) - 1)),
          stats: { kills: d.kills, deaths: d.deaths },
        };
      });

      out.push({
        _id: randomUUID(),
        at: new Date(`${day}T${hh}:${mm}:00.000Z`),
        monthKey: day.slice(0, 7),
        dayKey: day,
        awardedBy: id('amit'),
        results,
        events,
      });
    });
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
  const games = db.collection<GameDoc>('games');
  const metrics = db.collection<MetricDoc>('metrics');
  const rules = db.collection<AchievementRuleDoc>('achievementRules');
  const content = db.collection('content');

  // Idempotent: clear only what a previous seed created.
  await users.deleteMany({ _id: { $regex: '^seed-' } });
  await games.deleteMany({ 'results.racerId': { $regex: '^seed-' } });
  await rules.deleteMany({ _id: { $regex: '^seed-' } });
  await metrics.deleteMany({ _id: { $in: SEED_METRICS.map((m) => m._id) } });

  const now = new Date().toISOString();
  const userDocs = SEEDS.map(buildUser);
  const gameDocs = buildGames();

  await users.insertMany(userDocs);
  await games.insertMany(gameDocs);
  await metrics.insertMany(SEED_METRICS.map((m) => ({ ...m, createdAt: now, updatedAt: now })));
  await rules.insertMany(SEED_RULES.map((r) => ({ ...r, createdAt: now, updatedAt: now })));

  // Puns, only if the document doesn't exist yet.
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

  console.log(
    `Seeded ${userDocs.length} racers, ${gameDocs.length} games, ` +
      `${SEED_METRICS.length} metrics and ${SEED_RULES.length} achievement rules.`,
  );
  console.log(`Database: ${db.databaseName}`);
  console.log('\nNote: seeded racers cannot sign in — they have no real Google account.');

  await client.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
