import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Load apps/api/.env(.local) into process.env for the standalone scripts —
 * seed, smoke, preflight — that run outside Nest and so never trigger
 * ConfigModule.
 *
 * Without this, `npm run seed` from the repo root sees none of your `.env`
 * (only the server does), which reads as "MONGODB_URI is not set" even though
 * the file is right there.
 *
 * Precedence mirrors app.module's ConfigModule:
 *   .env.local  >  .env  >  nothing
 * and the real environment beats both — we only fill keys that are still
 * undefined, so `MONGODB_URI=… npm run seed` still overrides the file.
 */
function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  // __dirname is apps/api/src/common (ts-node) or apps/api/dist/common (built),
  // so '..','..' lands on apps/api either way.
  const apiRoot = resolve(__dirname, '..', '..');

  // .env.local first so its values win; each file only fills still-unset keys.
  for (const file of [resolve(apiRoot, '.env.local'), resolve(apiRoot, '.env')]) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

// Load on import, so a bare `import './common/load-env'` at the top of a script
// is all it takes.
loadEnv();
