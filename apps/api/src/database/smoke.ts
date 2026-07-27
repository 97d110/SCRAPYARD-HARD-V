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
 *   JWT_SECRET=smoke npm run smoke
 *
 * It DROPS the database it points at, so give it a scratch one — the name must
 * contain "smoke" or "test". Exits non-zero on any failed assertion.
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
import { MongoClient } from 'mongodb';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { GoogleStrategy } from '../auth/google.strategy';
import { SESSION_COOKIE } from '../auth/jwt.strategy';
import { UsersService } from '../users/users.service';
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
    'POST /scores/award needs a session',
    (await call('POST', '/scores/award', { body: { winnerId: 'seed-dana' } })).status === 401,
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

  // --- the award path --------------------------------------------------------
  // Under the file store this was a five-file cascade inside a mutex. It is now
  // one insert, and boards are aggregated fresh — so these checks verify the
  // aggregation agrees with the raw collection, not that copies stayed in step.
  console.log('\nawarding a win');
  const before = await call('GET', '/scores', { token: adminToken });
  const beforeAll = before.body.allTime.totalPoints;
  const beforeDana =
    before.body.allTime.entries.find((e: any) => e.userId === 'seed-dana')?.points ?? 0;

  const award = await call('POST', '/scores/award', {
    token: adminToken,
    body: { winnerId: 'seed-dana', note: 'Volcano Loop, photo finish' },
  });
  check('POST /scores/award succeeds', award.status === 201, award.body);
  check('response reports the new total', award.body?.winner?.allTime === beforeDana + 1, award.body?.winner);
  check(
    'response carries all three fresh boards',
    Boolean(award.body?.boards?.allTime && award.body?.boards?.monthly && award.body?.boards?.daily),
  );

  const after = await call('GET', '/scores', { token: adminToken });
  check('all-time total incremented', after.body.allTime.totalPoints === beforeAll + 1);
  check(
    'monthly board reflects the win',
    after.body.monthly.entries.find((e: any) => e.userId === 'seed-dana').points >= 1,
  );
  check(
    'daily board reflects the win',
    after.body.daily.entries.find((e: any) => e.userId === 'seed-dana').points >= 1,
  );

  // The aggregation must agree with the raw collection.
  const verify = new MongoClient(uri);
  await verify.connect();
  const db = verify.db(dbName);
  const rawWins = await db.collection('wins').countDocuments();
  check('board total equals the wins collection count', after.body.allTime.totalPoints === rawWins, {
    board: after.body.allTime.totalPoints,
    collection: rawWins,
  });
  check(
    'the win was stored with its note',
    (await db.collection('wins').countDocuments({ note: 'Volcano Loop, photo finish' })) === 1,
  );
  check(
    'the win records who awarded it',
    (await db.collection('wins').countDocuments({ awardedBy: 'seed-amit' })) > 0,
  );
  check(
    'there is no scoreboard collection to drift',
    !(await db.listCollections({ name: 'scores' }).hasNext()),
  );

  const points = after.body.allTime.entries
    .filter((e: any) => e.points > 0)
    .map((e: any) => e.points);
  check('board is sorted descending', points.every((p: number, i: number) => i === 0 || points[i - 1] >= p));
  check(
    'rank 1 exists and is untied',
    after.body.allTime.entries[0].rank === 1 && after.body.allTime.entries[0].tied === false,
  );

  // --- profile & achievements ------------------------------------------------
  console.log('\nprofile & achievements');
  const profile = await call('GET', '/users/seed-amit', { token: racerToken });
  check('anyone can view another racer profile', profile.status === 200);
  check('profile returns achievements', profile.body.achievements.length === 18, profile.body.achievements?.length);
  check('seeded 6-day streak detected', profile.body.streaks.currentWinStreak >= 6, profile.body.streaks);
  check('Ignition unlocked', profile.body.achievements.find((a: any) => a.id === 'first_blood').unlocked === true);
  check('Blaze Legend still locked', profile.body.achievements.find((a: any) => a.id === 'wins_100').unlocked === false);
  check('activity window is 90 days', Object.keys(profile.body.activity).length === 90);
  check('daily-lead streak computed', typeof profile.body.streaks.currentDailyLeadStreak === 'number');
  check(
    'recent wins returned newest-first',
    profile.body.recentWins.length > 1 && profile.body.recentWins[0].at >= profile.body.recentWins[1].at,
  );
  check('404 for an unknown racer', (await call('GET', '/users/nope', { token: racerToken })).status === 404);

  // --- profile editing -------------------------------------------------------
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
  check('unseen period returns an empty board, not a 404', future.status === 200 && future.body.totalPoints === 0);
  const periods = await call('GET', '/scores/boards', { token: racerToken });
  check('period list includes all-time', periods.body.some((p: any) => p.key === 'all-time'));
  check('period list includes today', periods.body.some((p: any) => p.key === dayKey()));

  // --- admin content ---------------------------------------------------------
  console.log('\nadmin content');
  const types = await call('GET', '/admin/content/types', { token: adminToken });
  check('admin sees the content grid', types.status === 200 && types.body.length === 5, types.body?.length);
  check('export card is an action', types.body.find((t: any) => t.id === 'export').kind === 'action');

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

  // --- export ----------------------------------------------------------------
  console.log('\ndatabase export');
  check('export needs admin', (await call('GET', '/admin/export/summary', { token: racerToken })).status === 403);
  const summary = await call('GET', '/admin/export/summary', { token: adminToken });
  check('summary counts users', summary.body.users === 9, summary.body);
  check('summary counts wins', summary.body.wins === rawWins, summary.body);

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
    check('manifest counts match the collections', manifest.counts.wins === rawWins, manifest.counts);
    const dumpedWins = JSON.parse(await fs.readFile(path.join(unzipDir, 'database/wins.json'), 'utf8'));
    check('wins dump round-trips', Array.isArray(dumpedWins) && dumpedWins.length === rawWins);
    check(
      'README explains the restore',
      (await fs.readFile(path.join(unzipDir, 'README.txt'), 'utf8')).includes('mongoimport'),
    );
  }

  // --- concurrency -----------------------------------------------------------
  // The old design needed a global mutex here. Inserts are atomic, so this now
  // tests MongoDB rather than our own locking — which is precisely the point.
  console.log('\nconcurrent awards');
  const gilBefore = (await call('GET', '/users/seed-gil', { token: adminToken })).body.user.scores.allTime;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      call('POST', '/scores/award', { token: adminToken, body: { winnerId: 'seed-gil' } }),
    ),
  );
  const gilAfter = (await call('GET', '/users/seed-gil', { token: adminToken })).body.user.scores.allTime;
  check('12 parallel awards all landed (no lost writes)', gilAfter === gilBefore + 12, {
    expected: gilBefore + 12,
    actual: gilAfter,
  });
  const finalBoard = await call('GET', '/scores', { token: adminToken });
  const finalRaw = await db.collection('wins').countDocuments();
  check('board still equals the collection after concurrency', finalBoard.body.allTime.totalPoints === finalRaw);

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
    check('authenticated / includes the bundle', /\/assets\/index-[\w-]+\.js/.test(await authed.text()));
  }

  // --- hardening -------------------------------------------------------------
  console.log('\nhardening');
  check(
    'rejects a traversal attempt in a user id',
    [400, 404].includes((await call('GET', '/users/..%2F..%2Fetc%2Fpasswd', { token: racerToken })).status),
  );
  check(
    'rejects awarding to a traversal id',
    [400, 404].includes((await call('POST', '/scores/award', { token: adminToken, body: { winnerId: '../../etc/passwd' } })).status),
  );
  check(
    'rejects awarding to a non-existent racer',
    (await call('POST', '/scores/award', { token: adminToken, body: { winnerId: 'nobody' } })).status === 404,
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
