/**
 * End-to-end smoke test. Boots the real Nest app against a throwaway database,
 * mints a session token, and exercises every route — including the score-award
 * cascade, verifying that the user file, all three scoreboards and the index
 * are each updated by a single POST.
 *
 *   DATABASE_DIR=/tmp/scrapyard-smoke npx ts-node src/database/smoke.ts
 *
 * Exits non-zero on the first failed assertion.
 */
import 'reflect-metadata';
import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import express from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { GoogleStrategy } from '../auth/google.strategy';
import { SESSION_COOKIE } from '../auth/jwt.strategy';
import { UsersService } from '../users/users.service';
import { JsonStoreService } from './json-store.service';
import { mountLoginAssets, mountSpa } from '../web/serve-spa';
import { dayKey, monthKey } from '../common/period.util';

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
  const root = process.env.DATABASE_DIR!;
  const secret = process.env.JWT_SECRET!;

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  // Mirror main.ts exactly, including the /login prefix exclusion and the
  // session-gated static serving — otherwise the SPA-gate assertions below
  // would be testing a different app than the one we ship.
  app.setGlobalPrefix('api', { exclude: [{ path: 'login', method: RequestMethod.GET }] });
  mountLoginAssets(app);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  mountSpa(app);
  await app.listen(0);

  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const jwt = app.get(JwtService);
  const usersService = app.get(UsersService);

  // Two sessions: an admin (seed-amit) and a plain racer (seed-dana).
  const adminToken = jwt.sign(
    { sub: 'seed-amit', email: 'amit@cytactic.com', role: 'admin' },
    { secret, expiresIn: '1h' },
  );
  const racerToken = jwt.sign(
    { sub: 'seed-dana', email: 'dana@cytactic.com', role: 'racer' },
    { secret, expiresIn: '1h' },
  );

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

  const readJson = async <T>(relative: string): Promise<T> =>
    JSON.parse(await fs.readFile(path.join(root, relative), 'utf8')) as T;

  console.log(`\nAPI at ${url}\n`);

  // --- unauthenticated ------------------------------------------------------
  console.log('auth gate');
  check('GET /health is public', (await call('GET', '/health')).status === 200);
  check('GET /auth/config is public', (await call('GET', '/auth/config')).status === 200);
  check('GET /users needs a session', (await call('GET', '/users')).status === 401);
  check('GET /scores needs a session', (await call('GET', '/scores')).status === 401);
  check('POST /scores/award needs a session', (await call('POST', '/scores/award', { body: { winnerId: 'seed-dana' } })).status === 401);
  check(
    'GET /admin/content/types rejects a non-admin',
    (await call('GET', '/admin/content/types', { token: racerToken })).status === 403,
  );

  // --- boot payload ---------------------------------------------------------
  console.log('\nclient boot payload');
  const users = await call('GET', '/users', { token: adminToken });
  check('GET /users returns the roster', users.status === 200 && users.body.length === 8, users.body?.length);
  check('roster is sorted by all-time wins', users.body[0].scores.allTime >= users.body[1].scores.allTime);
  check('roster hides internal fields', !('wins' in users.body[0]) && !('googleId' in users.body[0]));

  const scores = await call('GET', '/scores', { token: adminToken });
  check('GET /scores returns three boards', Boolean(scores.body.allTime && scores.body.monthly && scores.body.daily));
  check('daily board key is today', scores.body.daily.key === dayKey(), scores.body.daily.key);
  check('monthly board key is this month', scores.body.monthly.key === monthKey(), scores.body.monthly.key);

  const puns = await call('GET', '/content/puns', { token: racerToken });
  check('GET /content/puns returns seeded puns', puns.status === 200 && puns.body.length > 15, puns.body?.length);
  check('every returned pun is enabled', puns.body.every((p: any) => p.enabled === true));

  // --- the score cascade ----------------------------------------------------
  console.log('\nscore award cascade');
  const before = {
    user: await readJson<any>('users/seed-dana.json'),
    allTime: await readJson<any>('scores/all-time.json'),
    index: await readJson<any>('index/index.json'),
  };

  const award = await call('POST', '/scores/award', {
    token: adminToken,
    body: { winnerId: 'seed-dana', note: 'Volcano Loop, photo finish' },
  });
  check('POST /scores/award succeeds', award.status === 201, award.body);
  check('response carries the winner total', award.body?.winner?.allTime === before.user.scores.allTime + 1, award.body?.winner);
  check('response carries all three fresh boards', Boolean(award.body?.boards?.allTime && award.body?.boards?.monthly && award.body?.boards?.daily));

  const after = {
    user: await readJson<any>('users/seed-dana.json'),
    allTime: await readJson<any>('scores/all-time.json'),
    monthly: await readJson<any>(`scores/monthly-${monthKey()}.json`),
    daily: await readJson<any>(`scores/daily-${dayKey()}.json`),
    index: await readJson<any>('index/index.json'),
  };

  check('1. user file all-time incremented', after.user.scores.allTime === before.user.scores.allTime + 1);
  check('1. user file monthly incremented', after.user.scores.monthly[monthKey()] === (before.user.scores.monthly[monthKey()] ?? 0) + 1);
  check('1. user file daily incremented', after.user.scores.daily[dayKey()] === (before.user.scores.daily[dayKey()] ?? 0) + 1);
  check('1. win logged newest-first with the note', after.user.wins[0].note === 'Volcano Loop, photo finish' && after.user.wins.length === before.user.wins.length + 1);
  check('1. win records who awarded it', after.user.wins[0].awardedBy === 'seed-amit');

  check('2. all-time board regenerated', after.allTime.totalPoints === before.allTime.totalPoints + 1);
  check('3. monthly board reflects the win', after.monthly.entries.find((e: any) => e.userId === 'seed-dana').points === after.user.scores.monthly[monthKey()]);
  check('4. daily board reflects the win', after.daily.entries.find((e: any) => e.userId === 'seed-dana').points === after.user.scores.daily[dayKey()]);
  check('5. index file touched', after.index.updatedAt > before.index.updatedAt);

  // Derived boards must agree with the user files, always.
  const allUsers = await Promise.all(
    (await fs.readdir(path.join(root, 'users')))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<any>(`users/${f}`)),
  );
  const sumFromUsers = allUsers.reduce((total, u) => total + u.scores.allTime, 0);
  check('derived total equals sum of user files', after.allTime.totalPoints === sumFromUsers, {
    board: after.allTime.totalPoints,
    users: sumFromUsers,
  });

  // Ranking integrity.
  const points = after.allTime.entries.map((e: any) => e.points);
  check('board is sorted descending', points.every((p: number, i: number) => i === 0 || points[i - 1] >= p));
  check('rank 1 exists and is unique-or-tied correctly', after.allTime.entries[0].rank === 1 && after.allTime.entries[0].tied === false);

  // --- index pointers -------------------------------------------------------
  console.log('\nindex pointers');
  // It lists every racer's email, so it must not be public.
  check('index needs a session', (await call('GET', '/database/index')).status === 401);
  check(
    'index rejects a non-admin',
    (await call('GET', '/database/index', { token: racerToken })).status === 403,
  );

  const index = await call('GET', '/database/index', { token: adminToken });
  check('index counts every user file', index.body.counts.users === 8, index.body.counts);  // still 8 here: runs before any new racer is created
  check('index lists a file path per user', index.body.users.every((u: any) => u.file.startsWith('users/')));
  check('index lists a file path per scoreboard', index.body.scoreboards.every((s: any) => s.file.startsWith('scores/')));
  check('index registers the puns content file', index.body.content.some((c: any) => c.file === 'content/puns.json'));

  // Every pointer must resolve to a file that actually exists.
  const pointers = [
    ...index.body.users.map((u: any) => u.file),
    ...index.body.scoreboards.map((s: any) => s.file),
    ...index.body.content.map((c: any) => c.file),
  ];
  const missing: string[] = [];
  for (const pointer of pointers) {
    await fs.access(path.join(root, pointer)).catch(() => missing.push(pointer));
  }
  check(`all ${pointers.length} index pointers resolve`, missing.length === 0, missing);

  // --- profile / achievements ----------------------------------------------
  console.log('\nprofile & achievements');
  const profile = await call('GET', '/users/seed-amit', { token: racerToken });
  check('anyone can view another racer profile', profile.status === 200);
  check('profile returns achievements', profile.body.achievements.length === 18, profile.body.achievements?.length);
  check('profile returns streaks', typeof profile.body.streaks.currentWinStreak === 'number');
  check('seeded 6-day streak detected', profile.body.streaks.currentWinStreak >= 6, profile.body.streaks);
  check('Ignition unlocked', profile.body.achievements.find((a: any) => a.id === 'first_blood').unlocked === true);
  check('Blaze Legend still locked', profile.body.achievements.find((a: any) => a.id === 'wins_100').unlocked === false);
  check('activity window is 90 days', Object.keys(profile.body.activity).length === 90);
  check('daily-lead streak computed', typeof profile.body.streaks.currentDailyLeadStreak === 'number');
  check('404 for an unknown racer', (await call('GET', '/users/nope', { token: racerToken })).status === 404);

  // --- profile editing rules -----------------------------------------------
  console.log('\nprofile editing');
  check(
    'cannot edit someone else',
    (await call('PATCH', '/users/seed-amit', { token: racerToken, body: { displayName: 'Hacked' } })).status === 403,
  );
  const edited = await call('PATCH', '/users/seed-dana', {
    token: racerToken,
    body: { displayName: 'Dana K.', tagline: 'Brakes are for quitters', accentColor: '#B6FF3C' },
  });
  check('can edit your own profile', edited.status === 200 && edited.body.displayName === 'Dana K.', edited.body);
  check('rejects a bad accent colour', (await call('PATCH', '/users/seed-dana', { token: racerToken, body: { accentColor: 'purple' } })).status === 400);
  check('rejects an unknown racer pick', (await call('PATCH', '/users/seed-dana', { token: racerToken, body: { favoriteRacer: 'Batmobile' } })).status === 400);
  check('rejects a non-https avatar', (await call('PATCH', '/users/seed-dana', { token: racerToken, body: { avatarUrl: 'javascript:alert(1)' } })).status === 400);
  check('rejects unknown fields', (await call('PATCH', '/users/seed-dana', { token: racerToken, body: { role: 'admin' } })).status === 400);

  // Renaming must propagate into the derived boards.
  const boardAfterRename = await readJson<any>('scores/all-time.json');
  check(
    'rename propagated to the derived board',
    boardAfterRename.entries.find((e: any) => e.userId === 'seed-dana').displayName === 'Dana K.',
  );

  // --- admin content -------------------------------------------------------
  console.log('\nadmin content');
  const types = await call('GET', '/admin/content/types', { token: adminToken });
  check('admin sees the content-type grid', types.status === 200 && types.body.length === 5, types.body?.length);
  check('puns are marked editable', types.body.find((t: any) => t.id === 'puns').editable === true);
  check('types carry search keywords', types.body.every((t: any) => t.keywords.length > 0));

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

  const publicPuns = await call('GET', '/content/puns', { token: racerToken });
  check('disabled pun hidden from the banner', !publicPuns.body.some((p: any) => p.id === created.body.id));

  const allPuns = await call('GET', '/admin/content/puns', { token: adminToken });
  check('disabled pun still visible to admin', allPuns.body.some((p: any) => p.id === created.body.id));

  const reversed = [...allPuns.body].reverse().map((p: any) => p.id);
  const reordered = await call('POST', '/admin/content/puns/reorder', { token: adminToken, body: { ids: reversed } });
  check('admin can reorder puns', reordered.body[0].id === reversed[0]);

  check('admin can delete a pun', (await call('DELETE', `/admin/content/puns/${created.body.id}`, { token: adminToken })).status === 204);
  check('deleting twice is a 404', (await call('DELETE', `/admin/content/puns/${created.body.id}`, { token: adminToken })).status === 404);

  // --- period lookups & rebuild --------------------------------------------
  console.log('\nperiods & rebuild');
  check('specific day board fetchable', (await call('GET', `/scores/board/${dayKey()}`, { token: racerToken })).status === 200);
  check('specific month board fetchable', (await call('GET', `/scores/board/${monthKey()}`, { token: racerToken })).status === 200);
  check('all-time board fetchable by key', (await call('GET', '/scores/board/all-time', { token: racerToken })).status === 200);
  check('malformed period rejected', (await call('GET', '/scores/board/last-tuesday', { token: racerToken })).status === 400);

  const emptyFuture = await call('GET', '/scores/board/2099-01-01', { token: racerToken });
  check('unseen period returns an empty board, not a 404', emptyFuture.status === 200 && emptyFuture.body.totalPoints === 0);

  check('rebuild demands confirmation', (await call('POST', '/scores/rebuild', { token: adminToken })).status === 400);
  const rebuilt = await call('POST', '/scores/rebuild?confirm=yes', { token: adminToken });
  check('rebuild regenerates every board', rebuilt.status === 201 && rebuilt.body.rebuilt > 40, rebuilt.body);

  const afterRebuild = await readJson<any>('scores/all-time.json');
  check('rebuild is idempotent', afterRebuild.totalPoints === after.allTime.totalPoints, {
    before: after.allTime.totalPoints,
    after: afterRebuild.totalPoints,
  });

  // --- concurrency ---------------------------------------------------------
  console.log('\nconcurrent writes');
  const baseline = (await readJson<any>('users/seed-gil.json')).scores.allTime;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      call('POST', '/scores/award', { token: adminToken, body: { winnerId: 'seed-gil' } }),
    ),
  );
  const gil = await readJson<any>('users/seed-gil.json');
  check('12 parallel awards all landed (no lost writes)', gil.scores.allTime === baseline + 12, {
    expected: baseline + 12,
    actual: gil.scores.allTime,
  });
  check('win log matches the counter', gil.wins.filter((w: any) => w.dayKey === dayKey()).length === (gil.scores.daily[dayKey()] ?? 0));

  const finalBoard = await readJson<any>('scores/all-time.json');
  const finalUsers = await Promise.all(
    (await fs.readdir(path.join(root, 'users')))
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<any>(`users/${f}`)),
  );
  check(
    'board still agrees with user files after concurrency',
    finalBoard.totalPoints === finalUsers.reduce((t, u) => t + u.scores.allTime, 0),
  );

  // --- real session issuance ------------------------------------------------
  // Regression guard: AuthService.issueSession() must sign with the SAME secret
  // JwtStrategy verifies with. These used to diverge — JwtModule.register() read
  // process.env at require-time, before ConfigModule loaded .env, so every
  // freshly-issued cookie failed verification and login looped forever. The
  // rest of this file signs its own tokens, so nothing else covers this path.
  console.log('\nsession issuance (the real AuthService path)');
  const authService = app.get(AuthService);
  const captured: Record<string, string> = {};
  const fakeResponse = {
    cookie(name: string, value: string) {
      captured[name] = value;
      return this;
    },
  } as unknown as import('express').Response;

  const issued = authService.issueSession(fakeResponse, await readJson<any>('users/seed-amit.json'));
  check('issueSession sets the session cookie', captured[SESSION_COOKIE] === issued);

  const viaCookie = await fetch(`${url}/api/auth/me`, {
    headers: { Cookie: `${SESSION_COOKIE}=${issued}` },
  });
  check('a real issued cookie authenticates', viaCookie.status === 200, viaCookie.status);
  check(
    'the same token works as Bearer',
    (await call('GET', '/auth/me', { token: issued })).status === 200,
  );
  const meBody = (await viaCookie.json()) as { id?: string };
  check('session resolves to the right racer', meBody.id === 'seed-amit', meBody?.id);

  // --- config actually loaded ----------------------------------------------
  console.log('\nconfig loading');
  const health = await call('GET', '/health');
  check(
    'SCRAPYARD_TIMEZONE is honoured (not silently UTC)',
    health.body.timezone === process.env.SCRAPYARD_TIMEZONE,
    { reported: health.body.timezone, expected: process.env.SCRAPYARD_TIMEZONE },
  );

  // --- domain lockdown ------------------------------------------------------
  console.log('\nworkspace domain restriction');
  const authConfig = await call('GET', '/auth/config');
  check(
    'login config advertises the permitted domain',
    authConfig.body.allowedDomains.includes('cytactic.com'),
    authConfig.body.allowedDomains,
  );
  check('login config names Google as the provider', authConfig.body.provider === 'google');

  // The gate itself lives in GoogleStrategy.validate(), which we can call
  // directly — no need to fake an OAuth round-trip to prove it rejects.
  const googleStrategy = app.get(GoogleStrategy);
  // Google's `sub` is an opaque numeric string, so mimic that rather than
  // passing an email — the user-id guard rejects anything with @ or . in it.
  const fakeSub = (email: string): string =>
    `1${[...email].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1e12, 7)}`;

  const tryLogin = (email: string, verified: boolean | string = true) =>
    new Promise<{ ok: boolean; message: string }>((resolve) => {
      void googleStrategy.validate(
        'access',
        'refresh',
        {
          id: fakeSub(email),
          displayName: 'Test Racer',
          emails: [{ value: email, verified } as never],
          photos: [{ value: '' }],
        } as never,
        ((error: Error | null, user?: unknown) =>
          resolve({ ok: !error && Boolean(user), message: error?.message ?? '' })) as never,
      );
    });

  const outsider = await tryLogin('stranger@gmail.com');
  check('rejects an out-of-domain Google account', !outsider.ok, outsider.message);
  check(
    'rejection message names the permitted domain',
    outsider.message.includes('@cytactic.com'),
    outsider.message,
  );

  const lookalike = await tryLogin('someone@notcytactic.com');
  check('rejects a look-alike domain', !(await tryLogin('a@cytactic.com.evil.com')).ok);
  check('rejects a domain that merely contains the allowed one', !lookalike.ok);

  const unverified = await tryLogin('newbie@cytactic.com', false);
  check('rejects an unverified email even in-domain', !unverified.ok, unverified.message);

  const insider = await tryLogin('newbie@cytactic.com');
  check('accepts an in-domain verified account', insider.ok, insider.message);

  // A rejected outsider must land back on the login screen with a readable
  // reason, not on a raw JSON 403.
  const callbackFailure = await fetch(`${url}/api/auth/google/callback?error=access_denied`, {
    redirect: 'manual',
  });
  check(
    'failed OAuth callback redirects instead of erroring',
    callbackFailure.status >= 300 && callbackFailure.status < 400,
    callbackFailure.status,
  );
  const redirectTarget = callbackFailure.headers.get('location') ?? '';
  check(
    'redirect carries an authError the login page can show',
    redirectTarget.includes('authError='),
    redirectTarget,
  );

  const newbie = await usersService.findByEmail('newbie@cytactic.com');
  check('new in-domain racer gets a file', newbie !== null);
  check('new racer is NOT auto-admin when ADMIN_EMAILS is set', newbie?.role === 'racer', newbie?.role);

  // --- admin reconciliation -------------------------------------------------
  // ADMIN_EMAILS is declarative: it must apply on every login, not just at
  // account creation, or adding yourself to the list later would never work.
  console.log('\nadmin reconciliation (ADMIN_EMAILS)');
  const promoted = await usersService.upsertFromGoogle({
    googleId: 'seed-amit',
    email: 'amit@cytactic.com',
    fullName: 'Amit Nino',
    avatarUrl: '',
  });
  check('listed email is admin on login', promoted.role === 'admin', promoted.role);

  // Simulate having signed in before ADMIN_EMAILS was configured.
  const demotedTarget = await usersService.requireRaw('seed-dana');
  await fs.writeFile(
    path.join(root, 'users/seed-dana.json'),
    JSON.stringify({ ...demotedTarget, role: 'admin' }, null, 2),
  );
  const reconciled = await usersService.upsertFromGoogle({
    googleId: 'seed-dana',
    email: 'dana@cytactic.com',
    fullName: 'Dana Kessler',
    avatarUrl: '',
  });
  check('unlisted email is demoted on login', reconciled.role === 'racer', reconciled.role);
  check(
    'demoted racer loses admin routes',
    (await call('GET', '/admin/content/types', {
      token: jwt.sign({ sub: 'seed-dana', email: 'dana@cytactic.com', role: 'admin' }, { secret, expiresIn: '1h' }),
    })).status === 403,
  );

  // --- orphan cleanup -------------------------------------------------------
  // Deleting a user file then rebuilding must remove boards nobody has data for,
  // or the leaderboard keeps serving a racer who no longer exists.
  console.log('\norphan cleanup');
  const ghostDay = '2020-03-15';
  await fs.writeFile(
    path.join(root, 'users/ghost.json'),
    JSON.stringify(
      {
        id: 'ghost', googleId: 'ghost', email: 'ghost@cytactic.com', domain: 'cytactic.com',
        role: 'racer', googleFullName: 'Ghost', googleAvatarUrl: '', displayName: 'Ghost',
        avatarUrl: '', tagline: '', favoriteRacer: 'UFO', accentColor: '#FF2D95',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        scores: { allTime: 3, monthly: { '2020-03': 3 }, daily: { [ghostDay]: 3 } },
        wins: [],
      },
      null,
      2,
    ),
  );
  await call('POST', '/scores/rebuild?confirm=yes', { token: adminToken });
  check(
    "ghost's historical board was created",
    (await call('GET', `/scores/board/${ghostDay}`, { token: adminToken })).body.totalPoints === 3,
  );

  await fs.unlink(path.join(root, 'users/ghost.json'));
  await call('POST', '/scores/rebuild?confirm=yes', { token: adminToken });

  const orphanGone = await fs
    .access(path.join(root, `scores/daily-${ghostDay}.json`))
    .then(() => false)
    .catch(() => true);
  check('orphaned board file deleted after rebuild', orphanGone);

  const idxAfterCleanup = await call('GET', '/database/index', { token: adminToken });
  check(
    'index no longer advertises the orphaned board',
    !idxAfterCleanup.body.scoreboards.some((s: any) => s.key === ghostDay),
  );
  check(
    'index no longer lists the deleted racer',
    !idxAfterCleanup.body.users.some((u: any) => u.id === 'ghost'),
  );

  // --- database export ------------------------------------------------------
  console.log('\ndatabase export');
  check(
    'export needs admin',
    (await call('GET', '/admin/export/summary', { token: racerToken })).status === 403,
  );
  check('export zip needs admin', (await fetch(`${url}/api/admin/export/database.zip`)).status === 401);

  // Count from disk rather than hardcoding — earlier sections create racers.
  const liveUserCount = (await fs.readdir(path.join(root, 'users'))).filter((f) =>
    f.endsWith('.json'),
  ).length;

  const exportSummary = await call('GET', '/admin/export/summary', { token: adminToken });
  check(
    'summary counts every user file',
    exportSummary.body.users === liveUserCount,
    { reported: exportSummary.body.users, onDisk: liveUserCount },
  );
  check('summary reports a byte total', exportSummary.body.totalBytes > 1000);

  const zipResponse = await fetch(`${url}/api/admin/export/database.zip`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  check('zip download returns 200', zipResponse.status === 200);
  check(
    'zip has the right content type',
    zipResponse.headers.get('content-type') === 'application/zip',
    zipResponse.headers.get('content-type'),
  );
  check(
    'zip sets an attachment filename',
    (zipResponse.headers.get('content-disposition') ?? '').includes('.zip'),
  );

  const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());
  check('zip has the PK magic bytes', zipBuffer.subarray(0, 2).toString() === 'PK');

  // Unzip it for real and verify the contents round-trip.
  const unzipDir = path.join(root, '..', 'scrapyard-unzip');
  await fs.rm(unzipDir, { recursive: true, force: true });
  await fs.mkdir(unzipDir, { recursive: true });
  const zipPath = path.join(unzipDir, 'export.zip');
  await fs.writeFile(zipPath, zipBuffer);

  const { execFileSync } = await import('child_process');
  let unzipped = true;
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', unzipDir], { stdio: 'pipe' });
  } catch {
    unzipped = false;
  }

  if (!unzipped) {
    console.log('  skip unzip verification (no `unzip` binary available)');
  } else {
    check('archive extracts cleanly', true);
    const manifest = JSON.parse(await fs.readFile(path.join(unzipDir, 'manifest.json'), 'utf8'));
    check('manifest names the exporting admin', manifest.exportedBy === 'amit@cytactic.com', manifest.exportedBy);
    check(
      'manifest user count matches disk',
      manifest.counts.users === liveUserCount,
      { manifest: manifest.counts.users, onDisk: liveUserCount },
    );
    check(
      'manifest file list matches what was extracted',
      Object.keys(manifest.files).every((relative) =>
        require('fs').existsSync(path.join(unzipDir, 'database', relative)),
      ),
    );
    check('README is included', await fs.readFile(path.join(unzipDir, 'README.txt'), 'utf8').then((t) => t.includes('SOURCE OF TRUTH')));

    // The exported user file must be byte-identical in content to the live one.
    const liveDana = await readJson<any>('users/seed-dana.json');
    const zippedDana = JSON.parse(
      await fs.readFile(path.join(unzipDir, 'database/users/seed-dana.json'), 'utf8'),
    );
    check('exported user file round-trips exactly', JSON.stringify(liveDana) === JSON.stringify(zippedDana));

    const zippedBoard = JSON.parse(
      await fs.readFile(path.join(unzipDir, 'database/scores/all-time.json'), 'utf8'),
    );
    check(
      'exported board lists every racer',
      zippedBoard.entries.length === liveUserCount,
      { entries: zippedBoard.entries.length, onDisk: liveUserCount },
    );
  }

  // --- admin grid includes the export action -------------------------------
  const gridTypes = await call('GET', '/admin/content/types', { token: adminToken });
  check('admin grid exposes the export card', gridTypes.body.some((t: any) => t.id === 'export'));
  check(
    'export card is an action, not content',
    gridTypes.body.find((t: any) => t.id === 'export').kind === 'action',
  );
  check(
    'export card is findable by searching "backup"',
    gridTypes.body.find((t: any) => t.id === 'export').keywords.includes('backup'),
  );

  // --- login page / SPA split ----------------------------------------------
  // The whole point of serving login separately: an anonymous visitor must get
  // the login page and NOTHING else — never the application bundle.
  console.log('\nlogin page & SPA gate');

  const loginPage = await fetch(`${url}/login`, { redirect: 'manual' });
  check('GET /login is public', loginPage.status === 200, loginPage.status);
  check(
    'login page is HTML',
    (loginPage.headers.get('content-type') ?? '').includes('text/html'),
    loginPage.headers.get('content-type'),
  );
  check(
    'login page is never cached',
    (loginPage.headers.get('cache-control') ?? '').includes('no-store'),
    loginPage.headers.get('cache-control'),
  );

  const loginHtml = await loginPage.text();
  check('login page offers the Google flow', loginHtml.includes('/api/auth/google'));
  check('login page names the permitted domain', loginHtml.includes('@cytactic.com'));
  check('login page draws Arthur', loginHtml.includes('<svg') && loginHtml.includes('arthur-hero'));
  check(
    'login page ships no application bundle',
    !loginHtml.includes('/assets/index-') && !loginHtml.includes('src="/src/'),
  );
  check(
    'login page has the dim + vignette layering',
    loginHtml.includes('class="scrim"') &&
      loginHtml.includes('class="grade"') &&
      loginHtml.includes('class="vignette"'),
  );
  check(
    'login page mounts the video backdrop',
    loginHtml.includes('youtube-nocookie.com/embed/') || loginHtml.includes('<video'),
  );

  // An authError in the query string must be rendered, and escaped.
  const errorPage = await fetch(
    `${url}/login?authError=${encodeURIComponent('Only @cytactic.com accounts <script>x</script>')}`,
  );
  const errorHtml = await errorPage.text();
  check('login page shows a rejection reason', errorHtml.includes('Only @cytactic.com accounts'));
  check(
    'login page escapes the reason (no injected script)',
    !errorHtml.includes('<script>x</script>') && errorHtml.includes('&lt;script&gt;'),
  );

  // Signed in? /login should get out of the way.
  const loginWhenSignedIn = await fetch(`${url}/login`, {
    headers: { Cookie: `${SESSION_COOKIE}=${issued}` },
    redirect: 'manual',
  });
  check(
    '/login redirects an already-signed-in racer to the app',
    loginWhenSignedIn.status === 302 && loginWhenSignedIn.headers.get('location') === '/',
    { status: loginWhenSignedIn.status, location: loginWhenSignedIn.headers.get('location') },
  );

  // The gate only exists when a built bundle is present. In CI it usually isn't,
  // so report rather than fail.
  const spaMounted = existsSync(
    path.resolve(__dirname, '..', '..', '..', 'web', 'dist', 'index.html'),
  );

  if (!spaMounted) {
    console.log('  skip SPA gate checks (no apps/web/dist — run `npm run build` first)');
  } else {
    for (const route of ['/', '/racers', '/admin', '/index.html']) {
      const anon = await fetch(`${url}${route}`, { redirect: 'manual' });
      check(
        `anonymous ${route} redirects to /login`,
        anon.status === 302 && anon.headers.get('location') === '/login',
        { route, status: anon.status, location: anon.headers.get('location') },
      );
      const body = await anon.text();
      check(
        `anonymous ${route} leaks no bundle reference`,
        !body.includes('/assets/index-'),
      );
    }

    const authedApp = await fetch(`${url}/`, {
      headers: { Cookie: `${SESSION_COOKIE}=${issued}` },
    });
    const authedHtml = await authedApp.text();
    check('authenticated / serves the app', authedApp.status === 200);
    check('authenticated / includes the bundle', /\/assets\/index-[\w-]+\.js/.test(authedHtml));

    const deepLink = await fetch(`${url}/racers`, {
      headers: { Cookie: `${SESSION_COOKIE}=${issued}` },
    });
    check('authenticated deep link falls back to index.html', deepLink.status === 200);

    // Asset requests get a flat 401, not an HTML redirect — a <script> tag
    // pointed at a login page just yields a confusing parse error.
    const assetPath = (/\/assets\/index-[\w-]+\.js/.exec(authedHtml) ?? [''])[0];
    if (assetPath) {
      const anonAsset = await fetch(`${url}${assetPath}`, { redirect: 'manual' });
      check('anonymous asset request is 401, not a redirect', anonAsset.status === 401, anonAsset.status);
      const authedAsset = await fetch(`${url}${assetPath}`, {
        headers: { Cookie: `${SESSION_COOKIE}=${issued}` },
      });
      check('authenticated asset request succeeds', authedAsset.status === 200);
      check(
        'hashed assets are cached immutably',
        (authedAsset.headers.get('cache-control') ?? '').includes('immutable'),
        authedAsset.headers.get('cache-control'),
      );
    }
  }

  // --- path traversal ------------------------------------------------------
  console.log('\nhardening');
  check(
    'rejects a traversal attempt in a user id',
    [400, 404].includes((await call('GET', '/users/..%2F..%2Fetc%2Fpasswd', { token: racerToken })).status),
  );
  check(
    'rejects awarding to a traversal id',
    [400, 404].includes((await call('POST', '/scores/award', { token: adminToken, body: { winnerId: '../../etc/passwd' } })).status),
  );

  // A nested transaction would deadlock silently; we detect it instead.
  const store = app.get(JsonStoreService);
  let nestedThrew = false;
  await store
    .transaction(async () => store.transaction(async () => undefined))
    .catch(() => {
      nestedThrew = true;
    });
  check('nested transaction is rejected, not deadlocked', nestedThrew);
  check(
    'store still works after the rejected nesting',
    (await call('GET', '/scores', { token: adminToken })).status === 200,
  );

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
