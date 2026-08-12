/**
 * End-to-end smoke test.
 *
 * Boots the real Nest app against a throwaway MongoDB database, seeds it, and
 * exercises every route — the auth gate, the domain restriction, admin
 * reconciliation, the award path, achievements, the zip export, and the
 * concurrency behaviour that used to need a mutex.
 *
 *   MONGODB_URI="mongodb://localhost:27017" \
 *   MONGODB_DB=scrapyard_smoke \
 *   ALLOWED_WORKSPACE_DOMAINS=cytactic.com ADMIN_EMAILS=amit@cytactic.com \
 *   GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy \
 *   GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback \
 *   JWT_SECRET=smoke DATA_ENCRYPTION_KEY=$(openssl rand -base64 32) npm run smoke
 *
 * It DROPS the database it points at, so give it a scratch one — the name must
 * contain "smoke" or "test". Exits non-zero on any failed assertion.
 */
import 'reflect-metadata';
// Load apps/api/.env so `npm run smoke` picks up config without inlining it.
import '../common/load-env';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import express from 'express';
import cookieParser from 'cookie-parser';
import { MongoClient } from 'mongodb';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { GoogleStrategy } from '../auth/google.strategy';
import { SESSION_COOKIE } from '../auth/jwt.strategy';
import { UsersService } from '../users/users.service';
import { mountLoginAssets, mountSpa } from '../web/serve-spa';
import { dayKey, monthKey } from '../common/period.util';
import type { LiveFrame } from '@scrapyard/shared';

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail !== undefined ? ` → ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  const secret = process.env.JWT_SECRET!;

  if (!uri) {
    console.error('MONGODB_URI is not set — point it at a scratch database.');
    process.exit(1);
  }
  if (!dbName || !/smoke|test/i.test(dbName)) {
    console.error(
      'Refusing to run: MONGODB_DB must be set and contain "smoke" or "test" ' +
        `(this suite DROPS the database). Got: ${dbName ?? '(unset)'}`,
    );
    process.exit(1);
  }

  // Start from empty so counts are deterministic.
  const admin = new MongoClient(uri);
  await admin.connect();
  await admin.db(dbName).dropDatabase();
  await admin.close();

  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const { execFileSync } = await import('child_process');

  console.log('\nseeding');
  execFileSync(
    'npx',
    ['ts-node', '-P', 'apps/api/tsconfig.json', 'apps/api/src/database/seed.ts'],
    { cwd: repoRoot, stdio: 'pipe', env: process.env },
  );
  console.log('  seeded');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.setGlobalPrefix('api', { exclude: [{ path: 'login', method: RequestMethod.GET }] });
  mountLoginAssets(app);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  mountSpa(app);
  await app.listen(0);

  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const jwt = app.get(JwtService);
  const usersService = app.get(UsersService);
  const googleStrategy = app.get(GoogleStrategy);
  const authService = app.get(AuthService);

  const call = async (
    method: string,
    endpoint: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${url}/api${endpoint}`, {
      method,
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  // Google's `sub` is an opaque numeric string; the id guard rejects @ and .
  const fakeSub = (email: string): string =>
    `1${[...email].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1e12, 7)}`;

  const signIn = (email: string, verified: boolean | string = true, name = 'Test Racer') =>
    new Promise<{ ok: boolean; message: string }>((resolve) => {
      void googleStrategy.validate(
        'access',
        'refresh',
        {
          id: fakeSub(email),
          displayName: name,
          emails: [{ value: email, verified } as never],
          photos: [{ value: '' }],
        } as never,
        ((error: Error | null, user?: unknown) =>
          resolve({ ok: !error && Boolean(user), message: error?.message ?? '' })) as never,
      );
    });

  const adminToken = jwt.sign(
    { sub: 'seed-amit', email: 'amit@cytactic.com', role: 'admin' },
    { secret, expiresIn: '1h' },
  );
  const racerToken = jwt.sign(
    { sub: 'seed-dana', email: 'dana@cytactic.com', role: 'racer' },
    { secret, expiresIn: '1h' },
  );

  console.log(`\nAPI at ${url}  ·  db ${dbName}\n`);

  // --- auth gate -------------------------------------------------------------
  console.log('auth gate');
  check('GET /health is public', (await call('GET', '/health')).status === 200);
  check('GET /auth/config is public', (await call('GET', '/auth/config')).status === 200);
  check('GET /users needs a session', (await call('GET', '/users')).status === 401);
  check('GET /scores needs a session', (await call('GET', '/scores')).status === 401);
  check(
    'POST /scores/record needs a session',
    (await call('POST', '/scores/record', {
      body: { results: [{ racerId: 'seed-dana', place: 1, gameScore: 15 }, { racerId: 'seed-noam', place: 2, gameScore: 10 }] },
    })).status === 401,
  );
  check(
    'admin routes reject a non-admin',
    (await call('GET', '/admin/content/types', { token: racerToken })).status === 403,
  );

  // --- boot payload ----------------------------------------------------------
  console.log('\nclient boot payload');
  const users = await call('GET', '/users', { token: adminToken });
  check('GET /users returns the roster', users.status === 200 && users.body.length === 8, users.body?.length);
  check('roster is sorted by all-time wins', users.body[0].scores.allTime >= users.body[1].scores.allTime);
  check('roster hides internal fields', !('wins' in users.body[0]) && !('googleId' in users.body[0]));
  check('roster carries computed scores', typeof users.body[0].scores.allTime === 'number');

  const scores = await call('GET', '/scores', { token: adminToken });
  check('GET /scores returns three boards', Boolean(scores.body.allTime && scores.body.monthly && scores.body.daily));
  check('daily board key is today', scores.body.daily.key === dayKey(), scores.body.daily.key);
  check('monthly board key is this month', scores.body.monthly.key === monthKey(), scores.body.monthly.key);
  check('all-time board lists every racer', scores.body.allTime.entries.length === 8);

  const puns = await call('GET', '/content/puns', { token: racerToken });
  check('GET /content/puns returns seeded puns', puns.status === 200 && puns.body.length > 15, puns.body?.length);
  check('every returned pun is enabled', puns.body.every((p: any) => p.enabled === true));

  // --- recording a race ------------------------------------------------------
  // One race = one immutable `games` document, boards aggregated fresh. Boards
  // rank on wins, so the all-time total must equal the sum of every racer's
  // first-place finishes.
  const recordGame = (
    results: Array<{ racerId: string; place: number; gameScore?: number; stats?: Record<string, number> }>,
    note?: string,
  ) => call('POST', '/scores/record', { token: adminToken, body: note ? { results, note } : { results } });

  console.log('\nrecording a race');
  const before = await call('GET', '/scores', { token: adminToken });
  const beforeAll = before.body.allTime.total;
  const beforeDanaWins =
    before.body.allTime.entries.find((e: any) => e.userId === 'seed-dana')?.metrics.wins ?? 0;

  // Dana wins (place 1); Noam/Omer place but don't win — +1 to all-time wins.
  const award = await recordGame(
    [
      { racerId: 'seed-dana', place: 1, gameScore: 15, stats: { kills: 4, deaths: 1 } },
      { racerId: 'seed-noam', place: 2, gameScore: 11, stats: { kills: 2, deaths: 3 } },
      { racerId: 'seed-omer', place: 3, gameScore: 6, stats: { kills: 1, deaths: 4 } },
    ],
    'Volcano Loop, photo finish',
  );
  check('POST /scores/record succeeds', award.status === 201, award.body);
  check('response returns the new game id', typeof award.body?.game?.id === 'string', award.body?.game);
  check('response reports the winner’s new all-time wins', award.body?.winner?.allTime === beforeDanaWins + 1, award.body?.winner);
  check(
    'response carries all three fresh boards',
    Boolean(award.body?.boards?.allTime && award.body?.boards?.monthly && award.body?.boards?.daily),
  );

  const after = await call('GET', '/scores', { token: adminToken });
  check('all-time wins incremented by the new win', after.body.allTime.total === beforeAll + 1, {
    before: beforeAll,
    after: after.body.allTime.total,
  });
  check(
    'monthly board reflects the win',
    after.body.monthly.entries.find((e: any) => e.userId === 'seed-dana').metrics.wins >= 1,
  );
  check(
    'daily board reflects the win',
    after.body.daily.entries.find((e: any) => e.userId === 'seed-dana').metrics.wins >= 1,
  );
  check(
    'boards carry the captured metric columns',
    after.body.allTime.columns.some((c: any) => c.id === 'kills') &&
      after.body.allTime.columns.some((c: any) => c.id === 'combat'),
  );
  check(
    'combat formula computes 2·kills − deaths',
    after.body.allTime.entries.find((e: any) => e.userId === 'seed-dana').metrics.combat ===
      2 * after.body.allTime.entries.find((e: any) => e.userId === 'seed-dana').metrics.kills -
        after.body.allTime.entries.find((e: any) => e.userId === 'seed-dana').metrics.deaths,
  );

  // A winner alone is a valid race — everything past first place is optional.
  const winnerOnly = await recordGame([{ racerId: 'seed-tamar', place: 1 }]);
  check('a winner-only race records (score optional)', winnerOnly.status === 201, winnerOnly.body);

  // The aggregation must agree with the raw collection.
  const verify = new MongoClient(uri);
  await verify.connect();
  const db = verify.db(dbName);
  const rawGames = await db.collection('games').countDocuments();
  const boardTotal = (b: any) => b.entries.reduce((s: number, e: any) => s + e.primary, 0);
  check('all-time total equals the sum of finisher wins', after.body.allTime.total === boardTotal(after.body.allTime), {
    total: after.body.allTime.total,
    summed: boardTotal(after.body.allTime),
  });
  check(
    'the race was stored with its note',
    (await db.collection('games').countDocuments({ note: 'Volcano Loop, photo finish' })) === 1,
  );
  check(
    'the race records who entered it',
    (await db.collection('games').countDocuments({ awardedBy: 'seed-amit' })) > 0,
  );
  check(
    'there is no scoreboard collection to drift',
    !(await db.listCollections({ name: 'scores' }).hasNext()),
  );

  const primaries = after.body.allTime.entries
    .filter((e: any) => e.primary > 0)
    .map((e: any) => e.primary);
  check('board is sorted descending by wins', primaries.every((p: number, i: number) => i === 0 || primaries[i - 1] >= p));
  check('rank 1 exists', after.body.allTime.entries[0].rank === 1);

  // --- rejects a malformed race ----------------------------------------------
  check('rejects a race with zero finishers', (await recordGame([])).status === 400);
  check(
    'rejects gap/tie in places',
    (await recordGame([
      { racerId: 'seed-dana', place: 1, gameScore: 15 },
      { racerId: 'seed-noam', place: 3, gameScore: 8 },
    ])).status === 400,
  );
  check(
    'rejects the same racer twice',
    (await recordGame([
      { racerId: 'seed-dana', place: 1, gameScore: 15 },
      { racerId: 'seed-dana', place: 2, gameScore: 8 },
    ])).status === 400,
  );

  // --- profile & achievements ------------------------------------------------
  console.log('\nprofile & achievements');
  const profile = await call('GET', '/users/seed-amit', { token: racerToken });
  check('anyone can view another racer profile', profile.status === 200);
  check('profile returns achievements (specials + rules)', profile.body.achievements.length === 24, profile.body.achievements?.length);
  check('profile carries metric totals', typeof profile.body.totals.gameScore === 'number' && typeof profile.body.totals.wins === 'number');
  check('profile carries metric columns', profile.body.columns.some((c: any) => c.id === 'gameScore'));
  check('seeded 6-day streak detected', profile.body.streaks.currentWinStreak >= 6, profile.body.streaks);
  check('Ignition (rule) unlocked', profile.body.achievements.find((a: any) => a.id === 'seed-first_blood').unlocked === true);
  check('No Brakes — 5 in a day (rule) unlocked', profile.body.achievements.find((a: any) => a.id === 'seed-day_five').unlocked === true);
  check('Blaze Legend (rule) still locked', profile.body.achievements.find((a: any) => a.id === 'seed-wins_100').unlocked === false);
  check('Happy Hour (special) unlocked', profile.body.achievements.find((a: any) => a.id === 'happy_hour').unlocked === true);
  check('Back-to-Back (special) unlocked', profile.body.achievements.find((a: any) => a.id === 'back_to_back').unlocked === true);
  check('activity window is 90 days', Object.keys(profile.body.activity).length === 90);
  check('daily-lead streak computed', typeof profile.body.streaks.currentDailyLeadStreak === 'number');
  check(
    'recent games returned newest-first',
    profile.body.recentGames.length > 1 && profile.body.recentGames[0].at >= profile.body.recentGames[1].at,
  );
  check('recent game carries a place and metrics', profile.body.recentGames[0].place >= 1 && typeof profile.body.recentGames[0].metrics.gameScore === 'number');
  check('404 for an unknown racer', (await call('GET', '/users/nope', { token: racerToken })).status === 404);

  // --- profile editing -------------------------------------------------------
  console.log('\nprofile editing');
  check(
    'cannot edit someone else',
    (await call('PATCH', '/users/seed-amit', { token: racerToken, body: { displayName: 'Hacked' } })).status === 403,
  );
  const edited = await call('PATCH', '/users/seed-dana', {
    token: racerToken,
    body: { displayName: 'Dana K.', tagline: 'Brakes are for quitters', raceColor: 'blue' },
  });
  check('can edit your own profile', edited.status === 200 && edited.body.displayName === 'Dana K.', edited.body);
  check('rejects an off-palette colour', (await call('PATCH', '/users/seed-dana', { token: racerToken, body: { raceColor: 'purple' } })).status === 400);
  check('rejects the retired accentColor field', (await call('PATCH', '/users/seed-dana', { token: racerToken, body: { accentColor: '#B6FF3C' } })).status === 400);
  check('rejects an unknown racer pick', (await call('PATCH', '/users/seed-dana', { token: racerToken, body: { favoriteRacer: 'Batmobile' } })).status === 400);
  check('rejects a non-https avatar', (await call('PATCH', '/users/seed-dana', { token: racerToken, body: { avatarUrl: 'javascript:alert(1)' } })).status === 400);
  check('rejects unknown fields', (await call('PATCH', '/users/seed-dana', { token: racerToken, body: { role: 'admin' } })).status === 400);

  // The $lookup means a rename needs no cascade — it shows up immediately.
  const renamed = await call('GET', '/scores', { token: adminToken });
  check(
    'rename visible on the board with no rebuild',
    renamed.body.allTime.entries.find((e: any) => e.userId === 'seed-dana').displayName === 'Dana K.',
  );

  // --- domain restriction ----------------------------------------------------
  console.log('\nworkspace domain restriction');
  const outsider = await signIn('stranger@gmail.com');
  check('rejects an out-of-domain account', !outsider.ok, outsider.message);
  check('rejection names the permitted domain', outsider.message.includes('@cytactic.com'));
  check('rejects a look-alike domain', !(await signIn('a@cytactic.com.evil.com')).ok);
  check('rejects an unverified email even in-domain', !(await signIn('newbie@cytactic.com', false)).ok);

  const insider = await signIn('newbie@cytactic.com');
  check('accepts an in-domain verified account', insider.ok, insider.message);
  const newbie = await usersService.findByEmail('newbie@cytactic.com');
  check('new racer is persisted', newbie !== null);
  check('new racer is NOT auto-admin when ADMIN_EMAILS is set', newbie?.role === 'racer', newbie?.role);
  check(
    'new racer starts at zero wins',
    (await call('GET', `/users/${newbie!.id}`, { token: adminToken })).body.user.scores.allTime === 0,
  );

  const callbackFailure = await fetch(`${url}/api/auth/google/callback?error=access_denied`, {
    redirect: 'manual',
  });
  check('failed OAuth callback redirects', callbackFailure.status >= 300 && callbackFailure.status < 400);
  check('redirect carries an authError', (callbackFailure.headers.get('location') ?? '').includes('authError='));

  // --- admin reconciliation --------------------------------------------------
  console.log('\nadmin reconciliation (ADMIN_EMAILS)');
  const promoted = await usersService.upsertFromGoogle({
    googleId: 'seed-amit',
    email: 'amit@cytactic.com',
    fullName: 'Amit Nino',
    avatarUrl: '',
  });
  check('listed email is admin on login', promoted.role === 'admin', promoted.role);
  await db.collection('users').updateOne({ _id: 'seed-dana' as never }, { $set: { role: 'admin' } });
  const reconciled = await usersService.upsertFromGoogle({
    googleId: 'seed-dana',
    email: 'dana@cytactic.com',
    fullName: 'Dana Kessler',
    avatarUrl: '',
  });
  check('unlisted email is demoted on login', reconciled.role === 'racer', reconciled.role);

  // --- real session issuance -------------------------------------------------
  console.log('\nsession issuance (the real AuthService path)');
  const captured: Record<string, string> = {};
  const fakeResponse = {
    cookie(name: string, value: string) {
      captured[name] = value;
      return this;
    },
  } as unknown as import('express').Response;
  const issued = authService.issueSession(fakeResponse, promoted);
  check('issueSession sets the cookie', captured[SESSION_COOKIE] === issued);
  const viaCookie = await fetch(`${url}/api/auth/me`, {
    headers: { Cookie: `${SESSION_COOKIE}=${issued}` },
  });
  check('a real issued cookie authenticates', viaCookie.status === 200, viaCookie.status);
  check('session resolves to the right racer', ((await viaCookie.json()) as { id?: string }).id === 'seed-amit');

  // --- config ----------------------------------------------------------------
  console.log('\nconfig loading');
  const health = await call('GET', '/health');
  check(
    'SCRAPYARD_TIMEZONE is honoured',
    health.body.timezone === (process.env.SCRAPYARD_TIMEZONE ?? 'UTC'),
    health.body.timezone,
  );
  check('health reports the database name', health.body.database === dbName, health.body.database);

  // --- periods ---------------------------------------------------------------
  console.log('\nperiods');
  check('specific day board fetchable', (await call('GET', `/scores/board/${dayKey()}`, { token: racerToken })).status === 200);
  check('specific month board fetchable', (await call('GET', `/scores/board/${monthKey()}`, { token: racerToken })).status === 200);
  check('all-time board fetchable by key', (await call('GET', '/scores/board/all-time', { token: racerToken })).status === 200);
  check('malformed period rejected', (await call('GET', '/scores/board/last-tuesday', { token: racerToken })).status === 400);
  const future = await call('GET', '/scores/board/2099-01-01', { token: racerToken });
  check('unseen period returns an empty board, not a 404', future.status === 200 && future.body.total === 0);
  const periods = await call('GET', '/scores/boards', { token: racerToken });
  check('period list includes all-time', periods.body.some((p: any) => p.key === 'all-time'));
  check('period list includes today', periods.body.some((p: any) => p.key === dayKey()));

  // --- admin content ---------------------------------------------------------
  console.log('\nadmin content');
  const types = await call('GET', '/admin/content/types', { token: adminToken });
  check('admin sees the content grid', types.status === 200 && types.body.length === 7, types.body?.length);
  check('export card is an action', types.body.find((t: any) => t.id === 'export').kind === 'action');
  check('metrics card is editable', types.body.find((t: any) => t.id === 'metrics')?.editable === true);
  check('achievements card is editable', types.body.find((t: any) => t.id === 'achievements')?.editable === true);

  const created = await call('POST', '/admin/content/puns', {
    token: adminToken,
    body: { text: 'Arthur left the engine running. On purpose.' },
  });
  check('admin can create a pun', created.status === 201 && created.body.enabled === true);
  check('too-short puns rejected', (await call('POST', '/admin/content/puns', { token: adminToken, body: { text: 'no' } })).status === 400);
  check('non-admin cannot create a pun', (await call('POST', '/admin/content/puns', { token: racerToken, body: { text: 'sneaky pun here' } })).status === 403);

  const disabled = await call('PATCH', `/admin/content/puns/${created.body.id}`, {
    token: adminToken,
    body: { enabled: false },
  });
  check('admin can disable a pun', disabled.body.enabled === false);
  check(
    'disabled pun hidden from the banner',
    !(await call('GET', '/content/puns', { token: racerToken })).body.some((p: any) => p.id === created.body.id),
  );
  const allPuns = await call('GET', '/admin/content/puns', { token: adminToken });
  check('disabled pun still visible to admin', allPuns.body.some((p: any) => p.id === created.body.id));

  const reversed = [...allPuns.body].reverse().map((p: any) => p.id);
  check(
    'admin can reorder puns',
    (await call('POST', '/admin/content/puns/reorder', { token: adminToken, body: { ids: reversed } })).body[0].id === reversed[0],
  );
  check('admin can delete a pun', (await call('DELETE', `/admin/content/puns/${created.body.id}`, { token: adminToken })).status === 204);
  check('deleting twice is a 404', (await call('DELETE', `/admin/content/puns/${created.body.id}`, { token: adminToken })).status === 404);

  // --- metrics & scoring engine ----------------------------------------------
  console.log('\nmetrics & scoring engine');
  const metricList = await call('GET', '/metrics', { token: racerToken });
  check('racers can read the enabled metric list', metricList.status === 200 && metricList.body.some((m: any) => m.id === 'points'));
  check('built-in points metric is present and non-editable', metricList.body.find((m: any) => m.id === 'points')?.builtin === true);
  check('seeded captured metric kills present', metricList.body.some((m: any) => m.id === 'kills' && m.kind === 'captured'));

  const adminMetrics = await call('GET', '/admin/metrics', { token: adminToken });
  check('admin sees every metric', adminMetrics.status === 200 && adminMetrics.body.some((m: any) => m.id === 'combat'));
  check('non-admin cannot list admin metrics', (await call('GET', '/admin/metrics', { token: racerToken })).status === 403);

  const newMetric = await call('POST', '/admin/metrics', {
    token: adminToken,
    body: { id: 'boosts', label: 'Boosts', kind: 'captured', aggregation: 'sum', unit: 'boosts', icon: 'zap' },
  });
  check('admin can create a captured metric', newMetric.status === 201 && newMetric.body.id === 'boosts');
  check('cannot reuse a built-in id', (await call('POST', '/admin/metrics', { token: adminToken, body: { id: 'points', label: 'X', kind: 'captured' } })).status === 400);
  check('cannot edit a built-in metric', (await call('PATCH', '/admin/metrics/points', { token: adminToken, body: { label: 'Nope' } })).status === 400);
  check(
    'formula referencing an unknown metric is rejected',
    (await call('POST', '/admin/metrics', { token: adminToken, body: { id: 'bad', label: 'Bad', kind: 'formula', formula: [{ metricId: 'ghost', weight: 1 }] } })).status === 400,
  );
  check('admin can delete a metric', (await call('DELETE', '/admin/metrics/boosts', { token: adminToken })).status === 204);

  // --- achievement rules -----------------------------------------------------
  console.log('\nachievement rules');
  const ruleList = await call('GET', '/admin/achievement-rules', { token: adminToken });
  check('admin sees the seeded rules', ruleList.status === 200 && ruleList.body.some((r: any) => r.id === 'seed-hat_trick'));
  const newRule = await call('POST', '/admin/achievement-rules', {
    token: adminToken,
    body: { name: 'Menace', metricId: 'kills', scope: 'all-time', threshold: 3, tier: 'bronze', icon: 'crosshair' },
  });
  check('admin can create a rule', newRule.status === 201 && typeof newRule.body.id === 'string');
  check('rule with unknown metric rejected', (await call('POST', '/admin/achievement-rules', { token: adminToken, body: { name: 'X', metricId: 'ghost', scope: 'all-time', threshold: 1 } })).status === 400);
  check('new rule appears on a profile', (await call('GET', '/users/seed-amit', { token: racerToken })).body.achievements.some((a: any) => a.id === newRule.body.id));
  check('admin can delete a rule', (await call('DELETE', `/admin/achievement-rules/${newRule.body.id}`, { token: adminToken })).status === 204);

  // --- export ----------------------------------------------------------------
  console.log('\ndatabase export');
  check('export needs admin', (await call('GET', '/admin/export/summary', { token: racerToken })).status === 403);
  const summary = await call('GET', '/admin/export/summary', { token: adminToken });
  check('summary counts users', summary.body.users === 9, summary.body);
  check('summary counts games', summary.body.games === rawGames, summary.body);

  const zipResponse = await fetch(`${url}/api/admin/export/database.zip`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  check('zip download returns 200', zipResponse.status === 200);
  check('zip content type', zipResponse.headers.get('content-type') === 'application/zip');
  const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());
  check('zip has the PK magic bytes', zipBuffer.subarray(0, 2).toString() === 'PK');

  const unzipDir = '/tmp/scrapyard-smoke-unzip';
  await fs.rm(unzipDir, { recursive: true, force: true });
  await fs.mkdir(unzipDir, { recursive: true });
  await fs.writeFile(path.join(unzipDir, 'export.zip'), zipBuffer);
  let unzipped = true;
  try {
    execFileSync('unzip', ['-q', '-o', path.join(unzipDir, 'export.zip'), '-d', unzipDir], {
      stdio: 'pipe',
    });
  } catch {
    unzipped = false;
  }
  if (!unzipped) {
    console.log('  skip unzip verification (no `unzip` binary)');
  } else {
    const manifest = JSON.parse(await fs.readFile(path.join(unzipDir, 'manifest.json'), 'utf8'));
    check('manifest names the exporting admin', manifest.exportedBy === 'amit@cytactic.com');
    check('manifest counts match the collections', manifest.counts.games === rawGames, manifest.counts);
    const dumpedGames = JSON.parse(await fs.readFile(path.join(unzipDir, 'database/games.json'), 'utf8'));
    check('games dump round-trips', Array.isArray(dumpedGames) && dumpedGames.length === rawGames);
    check(
      'README explains the restore',
      (await fs.readFile(path.join(unzipDir, 'README.txt'), 'utf8')).includes('mongoimport'),
    );
  }

  // --- concurrency -----------------------------------------------------------
  // The old design needed a global mutex here. Inserts are atomic, so this now
  // tests MongoDB rather than our own locking — which is precisely the point.
  console.log('\nconcurrent race records');
  const gilBefore = (await call('GET', '/users/seed-gil', { token: adminToken })).body.user.scores.allTime;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      recordGame([
        { racerId: 'seed-gil', place: 1, gameScore: 15 },
        { racerId: 'seed-lior', place: 2, gameScore: 9 },
      ]),
    ),
  );
  const gilAfter = (await call('GET', '/users/seed-gil', { token: adminToken })).body.user.scores.allTime;
  check('12 parallel records all landed (no lost writes)', gilAfter === gilBefore + 12, {
    expected: gilBefore + 12,
    actual: gilAfter,
  });
  const finalBoard = await call('GET', '/scores', { token: adminToken });
  const finalTotal = finalBoard.body.allTime.entries.reduce((s: number, e: any) => s + e.primary, 0);
  check('board total stays internally consistent after concurrency', finalBoard.body.allTime.total === finalTotal);

  // --- kill log & same-day revenge -------------------------------------------
  console.log('\nkill log & same-day revenge');
  const recordKills = (
    results: Array<{ racerId: string; place: number; gameScore: number }>,
    events: Array<{ killerId: string; victimId: string }>,
  ) => call('POST', '/scores/record', { token: adminToken, body: { results, events } });

  // Game A: Noam beats Dana and takes Dana out — Dana now owes Noam a grudge.
  const killA = await recordKills(
    [
      { racerId: 'seed-noam', place: 1, gameScore: 15 },
      { racerId: 'seed-dana', place: 2, gameScore: 9 },
    ],
    [{ killerId: 'seed-noam', victimId: 'seed-dana' }],
  );
  check('a race with a kill log records', killA.status === 201, killA.body);

  // Game B, same day: Dana gets Noam back — that kill must be tagged revenge.
  const killB = await recordKills(
    [
      { racerId: 'seed-dana', place: 1, gameScore: 15 },
      { racerId: 'seed-noam', place: 2, gameScore: 8 },
    ],
    [{ killerId: 'seed-dana', victimId: 'seed-noam' }],
  );
  check('the payback race records', killB.status === 201, killB.body);

  const danaProfile = await call('GET', '/users/seed-dana', { token: adminToken });
  const danaVsNoam = danaProfile.body.rivals.find((r: any) => r.userId === 'seed-noam');
  check('rivals panel tracks the head-to-head', Boolean(danaVsNoam), danaProfile.body.rivals);
  check('same-day payback is tagged revenge', (danaVsNoam?.yourRevenges ?? 0) >= 1, danaVsNoam);
  check('recent game carries the kill log', danaProfile.body.recentGames[0].events.length >= 1);
  check(
    'kills/deaths derive from the log (not typed)',
    danaProfile.body.recentGames.some((g: any) => (g.metrics.kills ?? 0) >= 1),
  );
  check(
    'rejects a self-kill',
    (await recordKills(
      [
        { racerId: 'seed-dana', place: 1, gameScore: 15 },
        { racerId: 'seed-noam', place: 2, gameScore: 8 },
      ],
      [{ killerId: 'seed-dana', victimId: 'seed-dana' }],
    )).status === 400,
  );
  check(
    'rejects a kill involving a non-racer',
    (await recordKills(
      [
        { racerId: 'seed-dana', place: 1, gameScore: 15 },
        { racerId: 'seed-noam', place: 2, gameScore: 8 },
      ],
      [{ killerId: 'seed-dana', victimId: 'seed-gil' }],
    )).status === 400,
  );

  // --- admin create racer & claim-on-login -----------------------------------
  // An admin adds a teammate by email; the seat is scoreable immediately and is
  // inherited (not duplicated) when that person first signs in with Google.
  console.log('\nadmin create racer & claim-on-login');
  const rookieEmail = 'rookie@cytactic.com';
  const rookie = await call('POST', '/admin/users', {
    token: adminToken,
    body: { email: rookieEmail, displayName: 'Rookie Racer' },
  });
  check('admin can create an unclaimed racer', rookie.status === 201 && rookie.body.claimed === false, rookie.body);
  check('the new seat starts at zero wins', rookie.body.scores.allTime === 0);
  check('non-admin cannot create a racer', (await call('POST', '/admin/users', { token: racerToken, body: { email: 'sneaky@cytactic.com', displayName: 'Sneaky' } })).status === 403);
  check('rejects an email off the allowlist', (await call('POST', '/admin/users', { token: adminToken, body: { email: 'outsider@gmail.com', displayName: 'Nope' } })).status === 400);
  const rookieId = rookie.body.id;
  check('the seat shows on the roster as unclaimed', (await call('GET', '/users', { token: adminToken })).body.some((u: any) => u.id === rookieId && u.claimed === false));

  // The claim: the same address signs in with Google for the first time.
  const claim = await signIn(rookieEmail, true, 'Rookie The Real');
  check('rookie can sign in and claim the seat', claim.ok, claim.message);
  const claimed = await usersService.findByEmail(rookieEmail);
  check('claim keeps the original seat id (no duplicate)', claimed?.id === rookieId, { before: rookieId, after: claimed?.id });
  check('the seat is now claimed', Boolean(claimed?.googleId));
  check('the admin-chosen display name survives the claim', claimed?.displayName === 'Rookie Racer', claimed?.displayName);

  // Adoption: a seeded seat carries a placeholder googleId. When the real
  // Google account signs in with the same email it must ADOPT that seat —
  // keeping its _id — so all wins/games/stats survive rather than refusing.
  const noamWinsBefore = (await call('GET', '/users/seed-noam', { token: adminToken })).body.user.scores.allTime;
  const noamAdopt = await signIn('noam@cytactic.com', true, 'Noam Real');
  check('a seeded seat is adopted by the real Google account', noamAdopt.ok, noamAdopt.message);
  const noamAfter = await usersService.findByEmail('noam@cytactic.com');
  check('adoption keeps the seat id (history intact)', noamAfter?.id === 'seed-noam', noamAfter?.id);
  check('adoption re-links to the real Google id', Boolean(noamAfter?.googleId) && noamAfter?.googleId !== 'seed-noam', noamAfter?.googleId);
  const noamWinsAfter = (await call('GET', '/users/seed-noam', { token: adminToken })).body.user.scores.allTime;
  check('wins survive the adoption', noamWinsAfter === noamWinsBefore, { before: noamWinsBefore, after: noamWinsAfter });

  // Deletion is only for an unclaimed, win-less seat — undoing a typo.
  const spare = await call('POST', '/admin/users', { token: adminToken, body: { email: 'spare@cytactic.com', displayName: 'Spare Seat' } });
  check('an unclaimed seat can be deleted', (await call('DELETE', `/admin/users/${spare.body.id}`, { token: adminToken })).status === 204);
  check('a claimed racer cannot be deleted', (await call('DELETE', `/admin/users/${rookieId}`, { token: adminToken })).status === 400);

  // --- login page & SPA gate -------------------------------------------------
  console.log('\nlogin page & SPA gate');
  const loginPage = await fetch(`${url}/login`, { redirect: 'manual' });
  check('GET /login is public', loginPage.status === 200);
  const loginHtml = await loginPage.text();
  check('login page offers the Google flow', loginHtml.includes('/api/auth/google'));
  check('login page ships no application bundle', !loginHtml.includes('/assets/index-'));
  check(
    'login page escapes an injected authError',
    (await (await fetch(`${url}/login?authError=${encodeURIComponent('<script>x</script>')}`)).text()).includes('&lt;script&gt;'),
  );

  const spaMounted = existsSync(path.resolve(__dirname, '..', '..', '..', 'web', 'dist', 'index.html'));
  if (!spaMounted) {
    console.log('  skip SPA gate checks (no apps/web/dist — run `npm run build` first)');
  } else {
    for (const route of ['/', '/racers', '/admin']) {
      const anon = await fetch(`${url}${route}`, { redirect: 'manual' });
      check(
        `anonymous ${route} redirects to /login`,
        anon.status === 302 && anon.headers.get('location') === '/login',
      );
    }
    const authed = await fetch(`${url}/`, { headers: { Cookie: `${SESSION_COOKIE}=${issued}` } });
    check('authenticated / serves the app', authed.status === 200);
    const shell = await authed.text();
    check('authenticated / includes the bundle', /\/assets\/index-[\w-]+\.js/.test(shell));

    /*
     * Nothing behind the gate may be marked `public`.
     *
     * This is a regression test for a real incident, and the reason it is
     * worth a check rather than a comment: the bug is invisible locally.
     * Nothing here caches, so a `public` header behaves identically to a
     * `private` one — right up until a CDN sits in front, stores one racer's
     * authenticated bundle, and serves it to anonymous callers without the
     * gate ever running. The header is the only place the mistake is visible,
     * so the header is what gets asserted.
     */
    const bundlePath = (shell.match(/\/assets\/index-[\w-]+\.js/) ?? [])[0];
    if (bundlePath) {
      const assetRes = await fetch(`${url}${bundlePath}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${issued}` },
      });
      const cache = assetRes.headers.get('cache-control') ?? '';
      check('the bundle is served to a session', assetRes.status === 200, assetRes.status);
      check(
        'the bundle is never marked public — a shared cache would bypass the gate',
        cache.includes('private') && !cache.includes('public'),
        cache,
      );
    }

    const refused = await fetch(`${url}${bundlePath ?? '/assets/probe.js'}`);
    check('an anonymous bundle request is refused', refused.status === 401, refused.status);
    check(
      'the refusal is not cacheable either',
      (refused.headers.get('cache-control') ?? '').includes('no-store'),
      refused.headers.get('cache-control'),
    );
  }

  // --- live channel ----------------------------------------------------------
  console.log('\nlive channel (polling)');
  {
    /**
     * Ask for everything after `since`. Omitting it is what a freshly-opened
     * tab does, and is answered with the current cursor and a resync.
     */
    const poll = (since: number | undefined, token?: string) =>
      call(
        'GET',
        since === undefined ? '/live/events' : `/live/events?since=${since}`,
        token ? { token } : {},
      );

    const findEvent = <T extends LiveFrame['type']>(
      body: { events?: Array<{ type: string }> },
      type: T,
    ): Extract<LiveFrame, { type: T }> | undefined =>
      body.events?.find((event) => event.type === type) as
        | Extract<LiveFrame, { type: T }>
        | undefined;

    /*
     * The gate, first. A channel anyone could read would hand every race, every
     * racer's name and the whole roster to an unauthenticated caller — which is
     * exactly what the WebSocket's hand-rolled upgrade check existed to
     * prevent. As an ordinary guarded route it is the same guard as everything
     * else, but that is worth proving rather than assuming.
     */
    const anonymous = await poll(undefined);
    check('an anonymous poll is refused with 401', anonymous.status === 401, anonymous.status);

    const first = await poll(undefined, racerToken);
    check('a session cookie polls successfully', first.status === 200, first.body);
    check(
      'a tab with no cursor is told to resync',
      first.body?.resync === true,
      first.body,
    );
    check(
      'the answer carries a deployment id for redeploy detection',
      typeof first.body?.deploymentId === 'string',
    );
    check('the answer carries a cursor', typeof first.body?.seq === 'number', first.body?.seq);

    let cursor = Number(first.body?.seq ?? 0);

    /*
     * A race recorded over HTTP must reach a poll that had nothing to do with
     * that request — the whole point of the channel.
     *
     * No waiting loop here, unlike the socket this replaced: the event is
     * written inside the request that caused it, so it is already durable by
     * the time the response arrives. If the next poll doesn't see it, that is a
     * real failure and not a slow one.
     */
    const tagged = await fetch(`${url}/api/scores/record`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
        'X-Scrapyard-Client': 'smoke-tab',
      },
      body: JSON.stringify({
        results: [
          { racerId: 'seed-noam', place: 1, gameScore: 15 },
          { racerId: 'seed-dana', place: 2, gameScore: 9 },
        ],
      }),
    });
    check('recording a race over HTTP still succeeds', tagged.status === 201, tagged.status);

    const afterRace = await poll(cursor, racerToken);
    check('the poll advances the cursor', Number(afterRace.body?.seq) > cursor, afterRace.body?.seq);
    check('the poll does not ask for a resync', afterRace.body?.resync === false);

    const recorded = findEvent(afterRace.body, 'game:recorded');
    check('the race arrives as game:recorded', Boolean(recorded), afterRace.body?.events);
    check(
      'game:recorded carries the winner the flyby needs',
      recorded?.winner?.id === 'seed-noam' &&
        Boolean(recorded.winner.displayName) &&
        Boolean(recorded.winner.raceColor),
      recorded?.winner,
    );
    check(
      'game:recorded reports the winner’s all-time wins',
      typeof recorded?.winner?.allTime === 'number',
    );
    check(
      'game:recorded echoes the calling tab as origin',
      recorded?.origin === 'smoke-tab',
      recorded?.origin,
    );
    check('the event is stamped with a server time', typeof recorded?.at === 'string');

    cursor = Number(afterRace.body?.seq);

    // Config and content, not just scores.
    const newPun = await call('POST', '/admin/content/puns', {
      token: adminToken,
      body: { text: 'The live channel tested this pun.' },
    });
    check('creating a pun succeeds', newPun.status === 201, newPun.body);

    const afterPun = await poll(cursor, racerToken);
    check(
      'a pun edit arrives as puns:changed',
      Boolean(findEvent(afterPun.body, 'puns:changed')),
      afterPun.body?.events,
    );
    check(
      'a change made without a tab id carries no origin',
      findEvent(afterPun.body, 'puns:changed')?.origin === undefined,
    );

    cursor = Number(afterPun.body?.seq);

    // A rename has no scores behind it, but every board joins the user document
    // on read — so it has to travel too.
    const renamed = await call('PATCH', '/users/seed-dana', {
      token: racerToken,
      body: { tagline: 'Brakes are a rumour.' },
    });
    check('editing your own profile succeeds', renamed.status === 200, renamed.body);

    const afterRename = await poll(cursor, racerToken);
    check(
      'a profile edit arrives as roster:changed',
      Boolean(findEvent(afterRename.body, 'roster:changed')),
      afterRename.body?.events,
    );
    check(
      'roster:changed says which racer moved, and why',
      findEvent(afterRename.body, 'roster:changed')?.reason === 'profile' &&
        findEvent(afterRename.body, 'roster:changed')?.userId === 'seed-dana',
      findEvent(afterRename.body, 'roster:changed'),
    );

    /*
     * A tab that fell behind, but not off the end. The log retains a bounded
     * history and this run is comfortably inside it, so the right answer is the
     * whole backlog and no resync — a resync here would mean refetching three
     * endpoints to learn something the log could have told us.
     */
    const fromStart = await poll(0, racerToken);
    check(
      'a cursor inside the retained history is served in full',
      fromStart.body?.resync === false && fromStart.body?.events?.length > 0,
      { resync: fromStart.body?.resync, count: fromStart.body?.events?.length },
    );
    check(
      'a backlog arrives in sequence order',
      Array.isArray(fromStart.body?.events) &&
        fromStart.body.events.every(
          (event: { seq: number }, index: number, all: Array<{ seq: number }>) =>
            index === 0 || event.seq > all[index - 1].seq,
        ),
    );

    /*
     * A cursor from the future — a log that was reset underneath a tab holding a
     * higher number from the previous one. Same answer, and worth its own check
     * because the arithmetic that catches it is a different branch.
     */
    const ahead = await poll(Number(afterRename.body?.seq) + 5_000, racerToken);
    check('a cursor ahead of the log forces a resync', ahead.body?.resync === true, ahead.body);

    // Nothing changed since the last poll: the common case, and it must be
    // cheap and empty rather than a resync.
    const quiet = await poll(Number(afterRename.body?.seq), racerToken);
    check(
      'a poll with nothing new returns no events and no resync',
      quiet.body?.resync === false && quiet.body?.events?.length === 0,
      quiet.body,
    );
  }

  // --- hardening -------------------------------------------------------------
  console.log('\nhardening');
  check(
    'rejects a traversal attempt in a user id',
    [400, 404].includes((await call('GET', '/users/..%2F..%2Fetc%2Fpasswd', { token: racerToken })).status),
  );
  check(
    'rejects recording with a traversal id',
    [400, 404].includes((await recordGame([
      { racerId: '../../etc/passwd', place: 1, gameScore: 15 },
      { racerId: 'seed-dana', place: 2, gameScore: 8 },
    ])).status),
  );
  check(
    'rejects recording with a non-existent racer',
    (await recordGame([
      { racerId: 'nobody', place: 1, gameScore: 15 },
      { racerId: 'seed-dana', place: 2, gameScore: 8 },
    ])).status === 404,
  );

  await verify.close();
  await app.close();

  console.log(`\n${'='.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`ALL GREEN — ${passed} assertions passed`);
  } else {
    console.log(`${passed} passed, ${failures.length} FAILED:`);
    failures.forEach((failure) => console.log(`  · ${failure}`));
  }
  console.log('='.repeat(56));

  process.exit(failures.length === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
