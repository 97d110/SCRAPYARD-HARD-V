/**
 * Preflight — prove the deployment is wired up, without a human clicking
 * "Sign in with Google".
 *
 * This exists because of a specific failure that cost an afternoon: Atlas
 * refuses a connection from a non-allowlisted IP by *killing the TLS
 * handshake*, not by returning an auth error. Node surfaces that as
 *
 *   error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error
 *
 * and because the first Mongo write in the whole app happens inside
 * GoogleStrategy.validate(), it arrives wrapped in an OAuth error message and
 * looks like Google's fault. It is not. Every check below is designed to name
 * the *subsystem* that failed, so that never happens twice.
 *
 * Free Render instances have no shell, so this also runs at boot and writes
 * its verdict to the service logs. `PREFLIGHT=off` disables that.
 *
 *   npm run preflight        # from your laptop, against any environment
 */
// Load apps/api/.env so `npm run preflight` works standalone. At server boot
// (main.ts imports this) ConfigModule has already run; loadEnv only fills
// still-unset keys, so it's a harmless no-op there.
import '../common/load-env';
import { MongoClient } from 'mongodb';

export type Status = 'pass' | 'fail' | 'warn' | 'skip';

export interface Check {
  name: string;
  status: Status;
  detail: string;
  /** What to actually do about it. Only set when something is wrong. */
  hint?: string;
}

const TIMEOUT_MS = 10_000;

/** Never print a secret. Enough to tell two client IDs apart, and no more. */
function fingerprint(value: string | undefined): string {
  if (!value) return '(unset)';
  return value.length <= 12 ? '(set)' : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/**
 * Google's OAuth error page carries the machine-readable reason in an
 * `authError` query parameter: base64url of a protobuf whose first
 * length-delimited field is the error code (`redirect_uri_mismatch`,
 * `invalid_client`, …).
 *
 * This encoding is NOT documented by Google, so treat a miss as "unknown"
 * rather than as a pass — the caller falls back to reporting the raw URL.
 */
function decodeAuthError(param: string): string | undefined {
  try {
    const bytes = Buffer.from(param.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    // Field 1, wire type 2 (length-delimited) => tag byte 0x0a, then a varint
    // length, then that many ASCII bytes.
    if (bytes.length < 2 || bytes[0] !== 0x0a) return undefined;
    const length = bytes[1];
    if (length === undefined || length > 64 || bytes.length < 2 + length) return undefined;
    const code = bytes.subarray(2, 2 + length).toString('utf8');
    return /^[a-z_]+$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** True for the OpenSSL signature Atlas produces for a blocked source IP. */
function isTlsInternalError(message: string): boolean {
  return /tlsv1 alert internal error|SSL alert number 80/i.test(message);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkEnvironment(): Check[] {
  const required = [
    'MONGODB_URI',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_CALLBACK_URL',
    'ALLOWED_WORKSPACE_DOMAINS',
    'JWT_SECRET',
    'DATA_ENCRYPTION_KEY',
  ];
  const missing = required.filter((name) => !process.env[name]);

  const checks: Check[] = [
    missing.length === 0
      ? { name: 'env', status: 'pass', detail: `all ${required.length} required variables set` }
      : {
          name: 'env',
          status: 'fail',
          detail: `missing: ${missing.join(', ')}`,
          hint: 'Render → your service → Environment. Blueprint values marked `sync: false` are never filled in for you.',
        },
  ];

  /*
   * The callback URL is the single most misconfigured value in this app, and
   * every mistake produces the same opaque `redirect_uri_mismatch`. Check the
   * shape locally before asking Google.
   */
  const callback = process.env.GOOGLE_CALLBACK_URL;
  if (callback) {
    const problems: string[] = [];
    let parsed: URL | undefined;
    try {
      parsed = new URL(callback);
    } catch {
      problems.push('not a valid absolute URL');
    }

    if (parsed) {
      if (!parsed.pathname.endsWith('/api/auth/google/callback')) {
        problems.push(`path is ${parsed.pathname}, expected /api/auth/google/callback`);
      }
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
        problems.push('must be https outside localhost');
      }
      if (callback !== callback.trim() || /\s/.test(callback)) {
        problems.push('contains whitespace');
      }

      // Render tells us our own public URL. If it disagrees with the callback,
      // the OAuth round trip will land somewhere else entirely.
      const external = process.env.RENDER_EXTERNAL_HOSTNAME;
      if (external && parsed.hostname !== external) {
        problems.push(`host is ${parsed.hostname} but this service answers on ${external}`);
      }
    }

    checks.push(
      problems.length === 0
        ? { name: 'callback-url', status: 'pass', detail: callback }
        : {
            name: 'callback-url',
            status: 'fail',
            detail: problems.join('; '),
            hint: 'This exact string must also appear under Authorised redirect URIs on the Google client — byte for byte.',
          },
    );
  }

  return checks;
}

/**
 * Mongo. The important part is not "did it connect" but "if it didn't, say
 * why in words the reader can act on".
 */
async function checkMongo(): Promise<Check> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return { name: 'mongodb', status: 'skip', detail: 'MONGODB_URI not set' };

  const dbName = process.env.MONGODB_DB || 'scrapyard';
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: TIMEOUT_MS,
    connectTimeoutMS: TIMEOUT_MS,
    maxPoolSize: 1,
  });

  try {
    await client.connect();
    const started = Date.now();
    await client.db(dbName).command({ ping: 1 });
    const users = await client.db(dbName).collection('users').countDocuments();
    return {
      name: 'mongodb',
      status: 'pass',
      detail: `ping ${Date.now() - started}ms · db "${dbName}" · ${users} racer(s)`,
    };
  } catch (error) {
    const text = message(error);

    if (isTlsInternalError(text)) {
      return {
        name: 'mongodb',
        status: 'fail',
        detail: 'TLS handshake rejected by Atlas (SSL alert 80)',
        hint:
          "This source IP is not on the cluster's access list. Atlas kills the handshake rather than " +
          'returning an auth error, which is why it reads as a TLS bug. Atlas → Network Access → ' +
          'Add IP Address → Allow Access From Anywhere (0.0.0.0/0). Render has no fixed egress IP.',
      };
    }
    if (/Authentication failed|bad auth/i.test(text)) {
      return {
        name: 'mongodb',
        status: 'fail',
        detail: 'authentication rejected',
        hint: 'Wrong user or password. If the password contains @ : / ? # [ ] or %, URL-encode it — or regenerate it alphanumeric.',
      };
    }
    if (/ENOTFOUND|querySrv|EAI_AGAIN/i.test(text)) {
      return {
        name: 'mongodb',
        status: 'fail',
        detail: 'cluster hostname does not resolve',
        hint: 'Check the host in MONGODB_URI. A mongodb+srv:// URI needs the cluster hostname, not a shard name.',
      };
    }
    return { name: 'mongodb', status: 'fail', detail: text };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Can this host reach Google over TLS at all? Runs before the OAuth checks so
 * a network problem can never be misread as a credentials problem.
 */
async function checkGoogleReachable(): Promise<Check> {
  try {
    const started = Date.now();
    const response = await fetch('https://accounts.google.com/.well-known/openid-configuration', {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { name: 'google-reachable', status: 'warn', detail: `discovery returned ${response.status}` };
    }
    const doc = (await response.json()) as { issuer?: string };
    return {
      name: 'google-reachable',
      status: 'pass',
      detail: `${doc.issuer ?? 'discovery ok'} · ${Date.now() - started}ms`,
    };
  } catch (error) {
    const text = message(error);
    return {
      name: 'google-reachable',
      status: 'fail',
      detail: text,
      hint: isTlsInternalError(text)
        ? 'A TLS alert from Google is unusual — far more often this signature comes from MongoDB Atlas. Check the mongodb row above.'
        : 'Outbound HTTPS is failing. Nothing in the OAuth flow can work until this passes.',
    };
  }
}

/**
 * Do the client ID and secret actually belong together?
 *
 * Exchange a deliberately bogus authorization code. Google answers
 * `invalid_client` if it can't authenticate the client, and `invalid_grant`
 * if it authenticated us fine and simply disliked the code — so
 * `invalid_grant` is the result we *want*.
 *
 * RFC 6749 §5.2 defines both. No token is issued, no consent is recorded, and
 * no user is involved.
 */
async function checkGoogleClient(): Promise<Check> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALLBACK_URL;

  if (!clientId || !clientSecret || !redirectUri) {
    return { name: 'google-client', status: 'skip', detail: 'credentials not set' };
  }

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'scrapyard-preflight-not-a-real-code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };

    switch (body.error) {
      case 'invalid_grant':
        // The bogus code was rejected — which means the credentials weren't.
        return {
          name: 'google-client',
          status: 'pass',
          detail: `client ${fingerprint(clientId)} authenticated (rejected the dummy code, as expected)`,
        };
      case 'invalid_client':
        return {
          name: 'google-client',
          status: 'fail',
          detail: `Google will not authenticate client ${fingerprint(clientId)}`,
          hint: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET do not match, or the client was deleted. Re-copy both from the same credential in the Google console.',
        };
      case 'deleted_client':
        return {
          name: 'google-client',
          status: 'fail',
          detail: 'this OAuth client has been deleted',
          hint: 'Deleted clients are restorable for 30 days in the Google console, otherwise create a new one.',
        };
      case undefined:
        return {
          name: 'google-client',
          status: 'warn',
          detail: `unexpected ${response.status} with no error field`,
        };
      default:
        return {
          name: 'google-client',
          status: 'warn',
          detail: `${body.error}: ${body.error_description ?? ''}`.trim(),
        };
    }
  } catch (error) {
    return { name: 'google-client', status: 'fail', detail: message(error) };
  }
}

/**
 * Is GOOGLE_CALLBACK_URL registered on the client?
 *
 * The token endpoint can't answer this — with no real code there is no stored
 * redirect URI to compare against. The authorization endpoint can: it 302s
 * either into the sign-in flow (accepted) or to /signin/oauth/error (rejected).
 * We never follow the redirect, so no sign-in page is ever loaded.
 */
async function checkRedirectUri(): Promise<Check> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_CALLBACK_URL;
  if (!clientId || !redirectUri) {
    return { name: 'redirect-uri', status: 'skip', detail: 'credentials not set' };
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
  }).toString();

  try {
    /*
     * Two ways to read the answer, because `redirect: 'manual'` is not
     * portable. The Fetch spec says it yields an opaque-redirect response —
     * status 0, no headers — while undici deviates and hands back the real 302
     * so that server-side code can act on it. Rather than bet on which
     * behaviour this Node build has, try the cheap path and fall back to
     * following the redirect and reading the URL we landed on.
     */
    let location = '';
    try {
      const manual = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      location = manual.headers.get('location') ?? '';
    } catch {
      // fall through to the follow path
    }

    if (!location) {
      const followed = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      location = followed.url;
    }

    if (!location) {
      return { name: 'redirect-uri', status: 'warn', detail: 'no redirect — inconclusive' };
    }

    if (!location.includes('/signin/oauth/error')) {
      // Landed in the real sign-in flow, so Google accepted the URI.
      return { name: 'redirect-uri', status: 'pass', detail: 'accepted by Google' };
    }

    const code = decodeAuthError(new URL(location).searchParams.get('authError') ?? '');
    if (code === 'redirect_uri_mismatch') {
      return {
        name: 'redirect-uri',
        status: 'fail',
        detail: `Google does not recognise ${redirectUri}`,
        hint: 'Google console → Credentials → your client → Authorised redirect URIs. Paste it there, not into Authorised JavaScript origins (that box rejects paths). Changes can take a few minutes to apply.',
      };
    }
    if (code === 'invalid_client') {
      return {
        name: 'redirect-uri',
        status: 'fail',
        detail: 'the OAuth client was not found',
        hint: 'GOOGLE_CLIENT_ID does not name an existing client.',
      };
    }
    return {
      name: 'redirect-uri',
      status: 'warn',
      detail: `Google returned an error page (${code ?? 'reason not decodable'})`,
      hint: 'Open the authorization URL in a browser to read the message Google renders.',
    };
  } catch (error) {
    return { name: 'redirect-uri', status: 'fail', detail: message(error) };
  }
}

/**
 * Push notifications are optional infrastructure, not a required one — unlike
 * the checks above, an unset VAPID pair is not a failure, just a feature
 * that's off. This exists so "why doesn't the notification toggle show up"
 * has an answer in the same place as every other configuration question.
 */
function checkPush(): Check {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey && !privateKey) {
    return {
      name: 'push',
      status: 'skip',
      detail: 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are off',
    };
  }
  if (!publicKey || !privateKey) {
    return {
      name: 'push',
      status: 'fail',
      detail: 'only one of VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY is set',
      hint: "They're a matched keypair — set both, or neither: npx web-push generate-vapid-keys",
    };
  }
  return { name: 'push', status: 'pass', detail: `configured (${fingerprint(publicKey)})` };
}

/**
 * What preflight deliberately does NOT test, so nobody reads a green run as a
 * broader guarantee than it is:
 *
 *  - Whether the consent screen is Internal or External. Google only enforces
 *    that after a user picks an account (`org_internal`), so no unauthenticated
 *    probe can see it.
 *  - Whether ALLOWED_WORKSPACE_DOMAINS names a real Workspace. Google never
 *    validates the `hd` hint at request time; only the ID token's `hd` claim is
 *    authoritative, and that needs a completed sign-in.
 *
 * The domain gate itself is covered by the smoke suite, which drives
 * GoogleStrategy.validate() directly.
 */
export async function runPreflight(): Promise<Check[]> {
  const checks = checkEnvironment();
  const [mongo, reachable, client, redirect] = await Promise.all([
    checkMongo(),
    checkGoogleReachable(),
    checkGoogleClient(),
    checkRedirectUri(),
  ]);
  return [...checks, mongo, reachable, client, redirect, checkPush()];
}

const GLYPH: Record<Status, string> = { pass: '✓', fail: '✗', warn: '!', skip: '·' };

export function formatReport(checks: Check[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  const lines = checks.map((check) => {
    const head = `  ${GLYPH[check.status]} ${check.name.padEnd(width)}  ${check.detail}`;
    return check.hint ? `${head}\n      → ${check.hint}` : head;
  });
  const failed = checks.filter((check) => check.status === 'fail').length;
  const verdict = failed === 0 ? 'Preflight passed' : `Preflight found ${failed} problem(s)`;
  return `${lines.join('\n')}\n  ${verdict}`;
}

/**
 * Load apps/api/.env for the standalone run.
 *
 * Hand-rolled rather than importing dotenv: dotenv is only present here as a
 * transitive dependency of @nestjs/config, and a diagnostic tool reaching into
 * another package's dependency tree is exactly the kind of thing that breaks
 * six months later. Existing variables always win, so
 * `MONGODB_URI=... npm run preflight` still works.
 */
function loadEnvFile(): void {
  const { readFileSync } = require('fs') as typeof import('fs');
  const { resolve } = require('path') as typeof import('path');
  let contents: string;
  try {
    contents = readFileSync(resolve(__dirname, '..', '..', '.env'), 'utf8');
  } catch {
    return;
  }

  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
}

/** Standalone: `npm run preflight`. Exits non-zero if anything failed. */
async function main(): Promise<void> {
  loadEnvFile();

  const checks = await runPreflight();
  console.log(`\nScrapyard preflight\n${formatReport(checks)}\n`);
  process.exit(checks.some((check) => check.status === 'fail') ? 1 : 0);
}

if (require.main === module) {
  void main();
}
