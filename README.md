# Scrapyard

A crew leaderboard, themed after **BlazeRush** (Targem Games, 2014) and pushed
into sci-fi neon. Google-Workspace-only sign-in, all-time / monthly / daily
standings, streaks, achievements, and a spaceship called Arthur who does a
victory lap every time somebody scores.

---

## Quick start

> First time? **[RUNNING.md](RUNNING.md)** is a step-by-step walkthrough,
> including the Google Cloud Console setup.

```bash
npm install

# 1. Configure the API (Google OAuth is required — there is no bypass)
cp apps/api/.env.example apps/api/.env
$EDITOR apps/api/.env

# 2. Optional: fill the database with demo racers so there's something to look at
npm run seed

# 3. Pick one:
npm run dev        # two ports, hot reload  — day-to-day work
npm run preview    # one port, no reload    — what actually deploys
```

### How many ports? One. Two only while developing.

This trips people up, so plainly:

| | Ports | URL | Why |
| --- | --- | --- | --- |
| `npm run dev` | **2** | http://localhost:5173 | Vite's dev server owns 5173 purely to give you hot module reload. It proxies `/api`, `/login` and `/login-assets` through to Nest on 3000. |
| `npm run preview` | **1** | http://localhost:3000 | Nest serves everything — login page, API, and the built bundle. |
| Docker / production | **1** | port 3000 | Identical to `preview`. No proxy, no second service. |

**The second port is a development convenience, not part of the architecture.**
Nothing in the deployed system knows about 5173 — and because Vite proxies rather
than redirects, the browser is same-origin in both modes, so the httpOnly session
cookie behaves identically.

The one behavioural difference: Vite serves the bundle unconditionally, so under
`npm run dev` the *client-side* redirect is what sends you to `/login`. Nest
withholds the bundle outright under `preview` and in production — use `preview`
when you want to verify the real boundary. See
[Why split it](#why-split-it).

### Google OAuth setup

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client ID**
2. Application type: **Web application**
3. Authorised redirect URI: `http://localhost:3000/api/auth/google/callback`
4. Put the client ID/secret into `apps/api/.env`

### Who can sign in

Sign-in is locked to `*@cytactic.com` via `ALLOWED_WORKSPACE_DOMAINS`.

The check happens twice. `hd` asks Google to pre-filter its account chooser to
the tenant — a UX nicety only, and trivially bypassable. The gate that actually
enforces it is server-side: `GoogleStrategy.validate()` re-derives the domain
from the OAuth-verified address and rejects anything off the list. Unverified
Google addresses are rejected too, failing *closed* if Google omits the field.

The API **refuses to boot** if `ALLOWED_WORKSPACE_DOMAINS` is missing or empty —
there is no open sign-in mode to fall into by accident. Both `cytactic.com` and
`@cytactic.com` are accepted, and the value is a comma-separated list.

A rejected sign-in redirects back to the login screen with a readable reason
rather than dumping a JSON 403 in the browser — being turned away is the
expected path for anyone outside the Workspace, so it looks designed.

### Who is an admin

`ADMIN_EMAILS` is the single source of truth, and it is **reconciled on every
login** — not just at account creation:

| Situation | Result |
| --- | --- |
| Email listed in `ADMIN_EMAILS` | promoted to admin at next login |
| Email not listed, `ADMIN_EMAILS` set | demoted to racer at next login |
| `ADMIN_EMAILS` empty | first racer to sign in becomes admin, with a loud warning |

Two consequences worth knowing:

- Sign-up order doesn't matter. `amit@cytactic.com` becomes admin whenever they
  first sign in, even if ten others got there first.
- Hand-editing `role` in a `users/*.json` file **won't survive that user's next
  login**. Deliberate — exactly one place decides who is an admin.

---

## Architecture

The login screen and the application are **two separate deliveries**. The wall
is server-rendered HTML; the React bundle is only handed to requests that
already hold a session.

```
  anonymous                                  authenticated
      │                                            │
      ▼                                            ▼
  GET /login                                   GET /
  ┌────────────────────────┐              ┌────────────────────────┐
  │ server-rendered HTML   │              │ apps/web — React 18    │
  │ inline CSS + SVG       │              │ Vite · TS · Tailwind   │
  │ ~16 KB, no JS bundle   │              │ served ONLY with a     │
  │ video backdrop         │              │ valid session cookie   │
  └───────────┬────────────┘              └───────────┬────────────┘
              │                                       │  /api
              └───────────────┬───────────────────────┘
                    ┌─────────▼────────────────────────────┐
                    │  apps/api — NestJS 10                │
                    │  Passport Google OAuth → JWT cookie  │
                    │  session gate in front of the bundle │
                    └──────────────┬───────────────────────┘
                                   │
                    ┌──────────────▼───────────────────────┐
                    │  apps/api/database — JSON files      │
                    │  atomic writes, serialised txns      │
                    └──────────────────────────────────────┘
```

### Why split it

Previously the SPA contained a `<LoginPage>` component and decided client-side
whether to show it. That meant every anonymous visitor downloaded the entire
application — leaderboard, admin page, all of it — before being told to sign in.
The client-side check was the only thing standing between them and the UI.

Now the boundary is server-side:

| Request | Anonymous | Authenticated |
| --- | --- | --- |
| `GET /login` | 200, the wall | 302 → `/` |
| `GET /`, `/racers`, `/admin` | 302 → `/login` | 200, `index.html` |
| `GET /assets/*.js` | **401** | 200, `immutable` cache |
| `GET /api/*` | per-route guards | per-route guards |

Assets return a bare 401 rather than an HTML redirect, because pointing a
`<script>` tag at a login page just produces a confusing parse error.

The React `Gate` still redirects on a 401 — but it's now a convenience for
sessions that expire mid-visit, not the security boundary.

### Login page background

The wall plays [(PS5) BlazeRush | Gameplay](https://www.youtube.com/watch?v=xt_1gJkjdec)
by Immortalize Games behind a deliberate layer stack:

```
5  content            panel: glass, backdrop-blur, rim highlight + deep shadow
4  grid + horizon      the Scrapyard furniture, sitting ON the footage
3  vignette            corners pulled down, focus to centre
2  dim + colour grade  the contrast pass — darkens and cools the midtones
1  video / embed       fades in only once actually playing
0  poster still        instant paint, so there is never a black flash
```

**Self-hosting is better than the embed.** Drop `background.mp4` into
`apps/api/public/login/` and it takes priority — no third-party dependency, no
branding to crop, nothing to be blocked by a corporate network. See
[`apps/api/public/login/README.md`](apps/api/public/login/README.md). With
neither source available the page falls back to the animated grid, which stands
on its own.

Set `LOGIN_BACKGROUND_YOUTUBE_ID=none` to skip video entirely.

### Repo layout

**One `package.json`, one `node_modules`, no workspaces.** `apps/*` and
`packages/*` are plain folders with their own `tsconfig`, wired together by a
single `paths` mapping.

```
package.json            the ONLY manifest
package-lock.json
node_modules/           the ONLY install
tsconfig.base.json      shared options + the @scrapyard/shared path mapping
apps/
  api/  tsconfig.json    NestJS  -> apps/api/dist/main.js
  web/  tsconfig.app.json React  -> apps/web/dist/
packages/
  shared/src/index.d.ts  domain types, imported by both
infra/                   OpenTofu — the GCP deployment
  *.tf                   VM, network, secrets, budget, killswitch
  templates/             the VM's startup script
  killswitch/            the Cloud Function that detaches billing
```

### Documentation

| File | What it's for |
| --- | --- |
| [README.md](README.md) | this — architecture and design decisions |
| [RUNNING.md](RUNNING.md) | first-run walkthrough, incl. Google Cloud Console setup |
| [DEPLOY.md](DEPLOY.md) | going live on GCP's free tier, and not paying by mistake |
| [infra/README.md](infra/README.md) | the OpenTofu module |
| [apps/api/public/login/README.md](apps/api/public/login/README.md) | dropping in a self-hosted login background |

#### Why the shared types are a `.d.ts`

`@scrapyard/shared` resolves through `paths` alone — no build step, no
`tsc-alias`, no bundler, no runtime loader. Two properties make that work, and
both depend on the file containing *only* types:

1. **It erases completely.** Type-only imports leave no `require()` in the
   compiled API output — verified: zero references to `@scrapyard/shared` in
   `apps/api/dist`. So `node dist/main.js` has nothing to resolve.
2. **It's exempt from `rootDir`.** TypeScript excludes declaration files from
   the rootDir containment check, so the API keeps `rootDir: src` and emits a
   flat `dist/main.js` while importing from outside its own directory.

The trade-off: no runtime values can live there. Shared constants (the racer
roster, the accent palette) stay in the API and reach the client over
`GET /api/users/options`. Adding real shared *code* later means bundling the API
or rewriting the emitted paths.

Every import site uses `import type` deliberately. esbuild — via Vite, and via
`tsx` if you try it — transpiles file by file and cannot tell a type import from
a value one, so a plain `import { UserRecord }` would survive into the output and
fail at runtime.

#### How "tree-shaking per app" actually happens

Two different mechanisms, because the two apps have different problems:

| App | Mechanism | Result |
| --- | --- | --- |
| web | Rollup tree-shakes the bundle | automatic, always on |
| api | `dependencies` / `devDependencies` split + `npm ci --omit=dev` | 402 pkgs / 221 MB → **212 / 72 MB** |

Every front-end library — React, react-router, lucide-react — is a
**devDependency**, because Vite bundles it at build time and Node never requires
it. That split is what replaces per-workspace pruning, and it's why dropping
workspaces costs nothing here.

> **The one thing you lose without workspaces:** nothing stops the API importing
> React, or the web importing NestJS. There is no enforced dependency boundary —
> only the `dependencies`/`devDependencies` split, which is a convention. If that
> ever bites, the fix is per-app manifests (npm workspaces) or pnpm.

#### Why ts-node and not tsx/esbuild

Nest's DI reads constructor parameter types from `emitDecoratorMetadata` output.
esbuild cannot produce that metadata — `tsx` fails at transform time on the
parameter decorators, and would fail at runtime on dependency resolution even if
it didn't. `ts-node` runs the real TypeScript compiler, so `dev`, `seed` and
`smoke` all use it.

### The database

Deliberately lo-fi. Plain JSON files, no engine.

```
apps/api/database/
├── users/                        source of truth
│   ├── <googleSub>.json          one file per racer, every period's score
│   └── seed-amit.json
├── scores/                       fully derived, never hand-authored
│   ├── all-time.json
│   ├── monthly-2026-07.json
│   └── daily-2026-07-26.json
├── content/
│   └── puns.json                 admin-editable banner copy
└── index/
    └── index.json                pointers to every file above
```

**Two properties make this safe without a real database:**

1. **Atomic writes** — every file is written to a temp path and `rename`d over
   the target, so a crash can never leave unparseable JSON.
2. **Serialised transactions** — `JsonStoreService.transaction()` is a single
   in-process promise chain acting as a mutex. The five-file award cascade
   cannot interleave with another request's cascade. (Verified: 12 parallel
   awards, zero lost writes.)

### The award cascade

`POST /api/scores/award` is one point to one winner, and one transaction:

```
POST /api/scores/award { winnerId }
        │
        ├─ 1. users/<winnerId>.json      allTime++, monthly[YYYY-MM]++, daily[YYYY-MM-DD]++, wins[]
        ├─ 2. scores/all-time.json       ← recomputed from ALL user files
        ├─ 3. scores/monthly-<month>.json  ← recomputed
        ├─ 4. scores/daily-<day>.json      ← recomputed
        └─ 5. index/index.json           ← regenerated
```

Steps 2–4 **recompute** rather than increment. A derived board therefore cannot
drift from the user files — and `POST /api/scores/rebuild?confirm=yes` can
regenerate everything at any time (useful after hand-editing a JSON file).

A profile edit that changes something a board *displays* — name, avatar,
accent, ride — also triggers a rebuild, because leaderboard entries cache that
identity for cheap client rendering.

### Client boot

Per spec, one burst on load, then everything is served from memory:

```
GET /api/auth/me        → session
GET /api/users          → full roster        ┐
GET /api/scores         → all three boards   ├─ Promise.all
GET /api/content/puns   → banner copy        ┘
```

Switching leaderboard tabs does no I/O at all.

### Achievements & streaks

Both are **derived on read**, nothing is stored. 18 badges across four tiers;
adding, retuning or removing one needs no migration.

- **Win streak** — consecutive calendar days with ≥1 win. Stays alive if your
  last win was today *or* yesterday, so you don't lose it before today's race.
- **Daily lead streak** — consecutive days finishing #1 on the daily board,
  computed by comparing every racer's daily map.

All "today" maths runs in one configured timezone (`SCRAPYARD_TIMEZONE`) so the
daily board flips at the same moment for everyone.

---

## Pages

| Route         | What                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `/`           | Leaderboard — all-time / monthly / daily tabs, `Add Score` overlay       |
| `/racers`     | Roster with all-time scores (side menu)                                  |
| `/racer/:id`  | Profile — achievements public, editor only on your own page              |
| `/admin`      | Searchable grid of content types; puns editor. Admin role only           |

`/login` is not in this table because it isn't part of the bundle — the server
renders it. See [Why split it](#why-split-it).

## API surface

| Method | Endpoint                          | Auth   |
| ------ | --------------------------------- | ------ |
| GET    | `/login`                          | public (302 → `/` if signed in) |
| GET    | `/login-assets/*`                 | public |
| GET    | `/api/health`                     | public |
| GET    | `/api/auth/config`                | public |
| GET    | `/api/auth/google`                | public |
| GET    | `/api/auth/google/callback`       | public |
| GET    | `/api/auth/me`                    | session |
| POST   | `/api/auth/logout`                | session |
| GET    | `/api/users`                      | session |
| GET    | `/api/users/options`              | session |
| GET    | `/api/users/:id`                  | session |
| PATCH  | `/api/users/:id`                  | self only |
| GET    | `/api/scores`                     | session |
| GET    | `/api/scores/boards`              | session |
| GET    | `/api/scores/board/:key`          | session |
| POST   | `/api/scores/award`               | session |
| POST   | `/api/scores/rebuild?confirm=yes` | session |
| GET    | `/api/content/puns`               | session |
| GET    | `/api/database/index`             | admin  |
| GET    | `/api/admin/content/types`        | admin  |
| CRUD   | `/api/admin/content/puns`         | admin  |
| GET    | `/api/admin/export/summary`       | admin  |
| GET    | `/api/admin/export/database.zip`  | admin  |

`:key` is `all-time`, `YYYY-MM` or `YYYY-MM-DD`. Unseen periods return an empty
board rather than a 404.

`POST /api/scores/rebuild` is admin-only: it rewrites every board while holding
the global write mutex, so leaving it open would let any signed-in racer starve
all other writes.

---

## Deployment

**→ [DEPLOY.md](DEPLOY.md)** — Google Cloud's always-free `e2-micro` plus a
Cloudflare Tunnel, for $0.00/month.

**→ [infra/README.md](infra/README.md)** — the OpenTofu that provisions all of it
with one `tofu apply`.

Read [Part 1](DEPLOY.md#part-1--never-pay-by-mistake) before you create anything
in GCP. The short version of the trap: **a GCP budget alert does not stop
spending** — it only emails you. The `infra/` module deploys a killswitch that
actually does, and blocks every billable resource shape with `validation` rules.

Two constraints carry over from the design:

- **One replica only.** The JSON store is single-writer by design; two containers
  on one volume would interleave the five-file award cascade.
- **The volume is the database.** Back it up — Admin → Export Database, or the
  tarball job in DEPLOY.md.

---

## Database export

`Admin → Export Database` downloads the entire JSON database as a zip. It's an
**action card** in the admin grid (searchable by "export", "backup", "zip",
"snapshot"…) — one click, progress on the card itself, and the result reported
in place.

```
scrapyard-database-2026-07-26.zip
├── manifest.json         export time, who ran it, every file with byte sizes
├── README.txt            restore instructions
└── database/
    ├── users/*.json
    ├── scores/*.json
    ├── content/*.json
    └── index/*.json
```

Two implementation details worth knowing:

- **Streamed, not buffered.** The archive is piped straight to the response, so
  memory stays flat regardless of how much history has accumulated.
- **Wrapped in a store transaction.** Without that, a concurrent score award
  could land between reading `users/` and reading `scores/`, producing a backup
  whose boards disagree with its user files.

To restore: stop the API, copy `database/` over your `DATABASE_DIR`, start it,
then `POST /api/scores/rebuild?confirm=yes`. Strictly you only need
`database/users/` and `database/content/` — everything else is derived, and the
rebuild is authoritative.

---

## Design language

BlazeRush is a chunky, toy-futurist top-down combat racer — fat little vehicles
on tracks suspended over three planets, boost arrows, sparks, explosions. The
site keeps that silhouette language and swaps the palette for cold neon.

| Token          | Hex       | Role                                     |
| -------------- | --------- | ---------------------------------------- |
| `void`         | `#04050C` | deep space asphalt                       |
| `panel`        | `#0D1122` | HUD plates                               |
| `blaze`        | `#FF6A00` | the game's fire/boost orange — primary   |
| `blaze.bright` | `#FFB020` | 1st place, highlights                    |
| `plasma`       | `#00E5FF` | cold counterpoint, grid lines            |
| `magenta`      | `#FF2D95` | gradient partner on CTAs                 |
| `toxic`        | `#B6FF3C` | boost-arrow green, "today" accent        |
| `violet`       | `#7C5CFF` | admin, horizon glow                      |

- **Type** — Orbitron (display), Chakra Petch (body), JetBrains Mono (data).
  Everything is `clamp()`-fluid.
- **Surfaces** — `.panel` clips its corners like a HUD plate and glows from a
  `--glow` variable, which each racer's accent overrides locally.
- **Motion** — perspective grid floor, drifting starfield, CRT scanlines,
  rotating conic-gradient rings, spark particles. All ambient loops are killed
  under `prefers-reduced-motion`; meaningful one-shot feedback survives.

### Arthur

BlazeRush's roster is 16 named pilots (Turboboy, Tailfin, Old Rowdy, Beast,
Predator, Dipnoi, DriftKing, Rex, Panzerflachbagger, Dee, Twins, UFO,
Mr. Shnek, Hotty, Pushback, Arrow); the *Star Track* DLC added spaceships.
Arthur here is an **original SVG drawing** in the game's saucer/UFO idiom — no
game assets are used or redistributed. He appears:

- spinning on his yaw axis between every pun in the top ticker
- idling with a hover bob on profile and admin pages
- **at full thrust across the entire viewport** whenever a score is submitted,
  trailing plasma and shedding sparks, tinted to the winner's accent

### Responsive

Three real targets, not just "mobile and not-mobile":

- **Mobile** — slide-over menu, card lists, single-column podium
- **Desktop** — permanent side rail, table layouts, 3-up podium
- **Huge (`3xl` 1920px / `4xl` 2560px)** — container widens to 1720/2200px, the
  rank list splits into two columns, achievements go 4–5 across, and inline
  comparison bars appear in the roster table

---

## Scripts

```bash
npm run dev          # two ports, hot reload (Vite 5173 -> Nest 3000)
npm run preview      # one port: build both, then Nest serves everything on 3000
npm run build        # tsc for the API, vite for the web bundle
npm run typecheck    # tsc --noEmit over both apps
npm run seed         # demo racers + wins + default puns
npm run smoke        # 147-assertion end-to-end test
```

The smoke test boots the real Nest app against a throwaway database and
verifies: the auth gate, the `@cytactic.com` domain restriction (including
look-alike domains and unverified addresses), `ADMIN_EMAILS` promotion and
demotion, real session issuance through `AuthService` (not just hand-signed
tokens), that `.env` is actually loaded, the five-file cascade,
index-pointer integrity, orphaned-board cleanup after a user file is deleted,
achievement and streak derivation, profile-edit propagation into derived boards,
admin permissions, the zip export (unzipped and byte-compared against the live
files), path-traversal rejection, nested-transaction detection, and
concurrent-write safety under 12 parallel awards, and the login/SPA split
(anonymous requests are redirected and leak no bundle reference; assets 401;
the login page escapes an injected `authError`).

The SPA-gate assertions need a built bundle — run `npm run build` first, or they
report as skipped.

```bash
DATABASE_DIR=/tmp/scrapyard-smoke \
ALLOWED_WORKSPACE_DOMAINS=cytactic.com \
GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy \
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback \
JWT_SECRET=smoke SCRAPYARD_TIMEZONE=UTC \
ADMIN_EMAILS=amit@cytactic.com \
npm run seed && npm run smoke
```

---

## Notes & trade-offs

- **Types are duplicated** between `apps/api/src/database/types.ts` and
  `apps/web/src/lib/types.ts` on purpose. A shared package would mean a build
  step between the two apps, which fights the lo-fi brief. Change one, change
  the other.
- **Seeded racers can't sign in** — they have no real Google account. Delete
  them with `rm apps/api/database/users/seed-*.json`, then hit
  `POST /api/scores/rebuild?confirm=yes`.
- **The single-process mutex is the concurrency story.** Run one API instance.
  Two instances against the same directory would need real file locks. The mutex
  is non-reentrant and *detects* nesting rather than deadlocking — helpers meant
  to run inside a transaction (`ScoreboardBuilder`, `IndexService`) call
  `store.write()` directly instead of opening their own.
- **Writes are serialised; reads are not.** A `GET /api/scores` issued mid-
  cascade can see the all-time board already incremented while the daily board
  is still a moment behind. Given the write volume here — a handful of races a
  day — this is not worth the machinery to fix. The zip export *is* wrapped in a
  transaction, because a torn backup would be a genuine problem.
- **No OAuth `state` parameter.** Login-CSRF (forcing someone's browser to
  complete sign-in as the attacker) is technically possible. The blast radius is
  small — every account is inside the Workspace allowlist, and `sameSite=lax`
  protects the state-changing routes — but adding `state` would need session
  middleware or a nonce cookie in front of Passport.
- **Win logs are capped at 1000 entries** per user so a JSON file stays a
  reasonable size. Aggregate scores are never capped.
- **Avatar uploads** are downscaled to 256px in the browser and stored as data
  URLs. No blob store, no CDN, no upload endpoint to secure.

BlazeRush is © Targem Games. This is an unaffiliated fan-themed internal tool.
