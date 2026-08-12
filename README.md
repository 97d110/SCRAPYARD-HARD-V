# Scrapyard

A crew leaderboard, themed after **BlazeRush** (Targem Games, 2014) and pushed
into sci-fi neon. Google-Workspace-only sign-in, all-time / monthly / daily
standings, streaks, achievements, and a spaceship called Arthur who does a
victory lap every time somebody scores.

**Stack:** NestJS + React + MongoDB Atlas, deployed to Vercel.

---

## Deploy to Vercel

Three things to set up. Budget ~20 minutes, most of it clicking through
consoles. Atlas and Vercel both have a free tier that never expires, so this
costs nothing.

### 1. MongoDB Atlas

[cloud.mongodb.com](https://cloud.mongodb.com) → **Create** → **Free (M0)**.
Put it in **eu-central-1 (Frankfurt)** to match the function region below —
otherwise every query crosses an ocean twice.

The free tier is 512 MB, 500 connections and never expires. This app writes a
few hundred bytes per race, so it will not trouble it.

| Step | Where | What |
| --- | --- | --- |
| Database user | Database Access → Add New | Username + password. **Read and write to any database.** |
| Network access | Network Access → Add IP | `0.0.0.0/0`. Serverless functions have no fixed egress address, so there is nothing narrower to allowlist; the database credentials are the real access control. |
| Connection string | Cluster → Connect → Drivers | Copy it |

> **URL-encode the password.** If it contains `@ : / ? # [ ] %` the connection
> string parses wrong and fails with an opaque error. Easiest to generate a
> password with letters and digits only.

### 2. Google OAuth client

Google Cloud Console → **APIs & Services → Credentials → Create OAuth client ID**
→ **Web application**.

There are two URL boxes and they are **not** interchangeable — this is the
single easiest thing to get wrong:

| Box | What goes in it |
| --- | --- |
| Authorised JavaScript origins | **leave empty.** It rejects anything with a path (`Invalid Origin: URIs must not contain a path`). We don't need it — the flow is a server-side redirect. |
| **Authorised redirect URIs** | `https://<your-project>.vercel.app/api/auth/google/callback`<br>`http://localhost:3000/api/auth/google/callback` |

Vercel derives the production domain from the project name, so a project called
`scrapyard-hard-v` lands on `scrapyard-hard-v.vercel.app` (it appends a suffix
if that's taken). You can therefore fill this in before the first deploy, but
check the real domain afterwards — a mismatch is `redirect_uri_mismatch` and
nothing else.

A client can hold several redirect URIs, so keep the localhost one for
development.

**Preview deployments cannot sign in.** Each gets its own generated hostname,
which will never be in this list. That is a deliberate consequence rather than a
problem to solve: previews are for checking everything up to the login page.

If your project sits in a Workspace organisation, set the consent screen's user
type to **Internal** — no verification, no scope review, and Google filters the
account chooser to your tenant before our own check even runs.

### 3. Vercel

Push the repo to GitHub, then **Add New → Project** and import it — or from a
checkout, `npx vercel link` followed by `npx vercel deploy --prod`.

[`vercel.json`](vercel.json) declares the whole deployment, and every line of it
is load-bearing:

| Key | Why |
| --- | --- |
| `framework: null` | The repo has Vite in its devDependencies, so Vercel's detection guesses "Vite" and tries to serve a static site — which would skip the server entirely. |
| `buildCommand` | `tsc` for the API, `vite build` for the client. Both need devDependencies, which is why `NODE_ENV=production` must never be set at *build* time. |
| `outputDirectory: "public"` | Vercel requires one. Ours is deliberately empty — see [`public/README.md`](public/README.md). Anything in it is served by the CDN *before* the session gate runs. |
| `rewrites` | Sends every path to the one function. Express does the routing inside, exactly as it does when the app runs as a process. |
| `functions.includeFiles` | Puts `apps/web/dist` in the deployment. Bundling traces `require`, which never reaches an asset directory, so without this the app boots and then cannot find its own bundle. |
| `regions: ["fra1"]` | Frankfurt, next to Atlas. |

Then set the environment variables (**Settings → Environment Variables**, or
`npx vercel env add NAME production`):

```dotenv
MONGODB_URI=mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=scrapyard-hard-v
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_CALLBACK_URL=https://<your-project>.vercel.app/api/auth/google/callback
JWT_SECRET=<openssl rand -hex 32>
DATA_ENCRYPTION_KEY=<openssl rand -base64 32>
ALLOWED_WORKSPACE_DOMAINS=cytactic.com
ADMIN_EMAILS=you@cytactic.com
SCRAPYARD_TIMEZONE=Asia/Jerusalem
TRUST_PROXY=true
PREFLIGHT=off
```

Optional on top of those: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
`VAPID_SUBJECT` for push, and `GROQ_API_KEY` / `GROQ_MODEL` /
`GROQ_TRANSCRIBE_MODEL` for voice entry. Leave either group unset and that
feature just hides itself.

Three of those deserve a note:

- **`TRUST_PROXY=true` is not optional.** TLS terminates at Vercel's edge, so
  the hop to the function is plain HTTP. `auth.controller.ts` builds the
  post-login redirect from `request.protocol`, so without this you are sent back
  to an `http://` URL after signing in.
- **`PREFLIGHT=off`.** The boot diagnostics open a second MongoClient and run
  DNS and OAuth checks. That is worth it once at the start of a long-lived
  process and wasteful on every cold start. Run it from a laptop instead:
  `npm run preflight`.
- **`WEB_ORIGIN` must stay unset.** One origin serves everything, so CORS stays
  off; setting it breaks post-login redirects.

`DATA_ENCRYPTION_KEY` encrypts every racer's email and Google id at rest — keep
a copy somewhere durable. Unlike `JWT_SECRET`, losing or rotating it doesn't
just log people out; it makes existing racers' email/Google id permanently
undecryptable, and they can no longer be looked up on login.

**Upgrading a deployment that already has real racers?** Set
`DATA_ENCRYPTION_KEY` and run the one-off migration against that database
*before* deploying this build — it encrypts everyone's existing plaintext
email/googleId in place (games, scores and achievements aren't touched):

```bash
DATA_ENCRYPTION_KEY="..." MONGODB_URI="mongodb+srv://..." npm run migrate:encrypt-users
```

Once it's green, seed demo data if you want something to look at (run it from
your laptop — there is no shell on a function):

```bash
MONGODB_URI="mongodb+srv://..." MONGODB_DB=scrapyard npm run seed
```

Visit the URL. You'll land on `/login`. Sign in with the account listed in
`ADMIN_EMAILS` and you're an admin from the first request.

### What "free" actually means here

| | |
| --- | --- |
| Function | 2 GB / 1 vCPU, fixed on Hobby |
| Idle | Nothing runs, and nothing is billed, between requests |
| Cold start | A second or so — building the Nest DI graph and opening an Atlas connection. Fluid compute keeps instances warm through a burst, so only the first person after a quiet spell pays it |
| Duration | 300 s ceiling; `vercel.json` caps this app at 60 s, which is well clear of the ~65 s worst case for voice entry |
| Invocations | 1M/month, and 1M edge requests. Every request counts, including each static asset — see the note in `public/README.md` |
| Active CPU | 4 CPU-hrs/month. Only counts code actually executing, not time waiting on Atlas or Groq |
| Provisioned memory | 360 GB-hrs/month — about 180 instance-hours at 2 GB. **This is the one to watch**, and the reason the live channel polls rather than holding a connection |
| Transfer | 100 GB out of the CDN, 10 GB out of the function |
| Disk | None. The filesystem is read-only apart from `/tmp` — fine, because all state is in Atlas |
| Request/response body | 4.5 MB, hard. Relevant to avatar uploads, voice audio and the database export |
| TLS | Free and managed, on `vercel.app` and on custom domains |

> The Hobby plan is [non-commercial personal use only](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage).
> Vercel's own examples are all about payments, ads and affiliate links, none of
> which this has — but the definition is broader than the examples, so if this
> ever becomes something a business depends on, Pro is the honest answer.

### Custom domain

Vercel → your project → **Settings → Domains** → add `scrapyard.example.com`,
then create the CNAME it shows you. TLS is issued automatically. **Add the new
callback URL to the Google client and update `GOOGLE_CALLBACK_URL`** — a
mismatch gives you `redirect_uri_mismatch`.

---

## Local development

```bash
npm install
cp apps/api/.env.example apps/api/.env    # fill in MONGODB_URI, Google creds, DATA_ENCRYPTION_KEY
npm run seed                              # optional demo racers

npm run dev        # two ports, hot reload  — day to day
npm run preview    # one port, no reload    — closer to production
```

`npm run dev` puts Vite on **5173** and Nest on **3000**, with Vite proxying
`/api`, `/login` and `/login-assets` through. Two ports exist only for hot
reload — nothing deployed knows about 5173.

Point `MONGODB_URI` at Atlas, or run one locally:

```bash
docker run -d -p 27017:27017 --name scrapyard-mongo mongo:7
# MONGODB_URI=mongodb://localhost:27017
```

### Tests

```bash
MONGODB_URI="mongodb://localhost:27017" MONGODB_DB=scrapyard_smoke \
ALLOWED_WORKSPACE_DOMAINS=cytactic.com ADMIN_EMAILS=amit@cytactic.com \
GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy \
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback \
JWT_SECRET=smoke DATA_ENCRYPTION_KEY=$(openssl rand -base64 32) npm run smoke
```

Boots the real Nest app, seeds, and exercises every route: auth gate, domain
restriction, admin reconciliation, the award path, achievements, the zip export,
12 concurrent awards, path-traversal rejection, and the live channel (an
anonymous poll is refused, then a real poll receives a race, a content edit and
a profile edit recorded over HTTP, and a cursor outside the retained history is
told to resync).

**It drops the database it points at**, so the name must contain `smoke` or
`test` — the suite refuses to run otherwise.

---

## How the data model works

Three collections. **No derived state anywhere.**

```
users     one document per racer, _id = the Google `sub` claim
wins      one immutable document per win  ← the only thing ever written
content   a single 'puns' document
```

### Wins are events, and that decides everything else

Recording a win is a single `insertOne`. Atomic by definition: no
read-modify-write, so no lock, no transaction, no cascade.

Every leaderboard is a `$group` over `wins`, computed on read:

```js
{ $match: { dayKey: '2026-07-26' } }        // or monthKey, or nothing
{ $group: { _id: '$userId', points: { $sum: 1 } } }
{ $lookup: { from: 'users', ... } }          // attach name, avatar, accent
{ $sort:  { points: -1, 'user.displayName': 1 } }
```

Three consequences worth knowing:

- **Boards cannot drift from the truth**, because there is no second copy to
  drift from. The previous file-based design maintained 40+ derived scoreboard
  files and needed a rebuild endpoint to repair them.
- **Renaming a racer needs no cascade.** The `$lookup` joins the user document
  at query time, so a new display name appears everywhere immediately.
- **No single-writer constraint**, so nothing breaks if you outgrow the free
  plan and scale to several instances.

### Achievements and streaks

Derived on read, nothing stored. Adding, retuning or removing a badge needs no
migration. Streaks come from a `(userId, dayKey)` aggregation that Mongo answers
straight from the index without touching documents.

---

## Live updates

Every open tab polls `/api/live/events` every ten seconds and asks what has
happened since it last checked. When the database changes, the other tabs find
out and re-read what moved — so a race scored on somebody's phone lands on
everyone else's board a few seconds later, with the winner's flyby, and nobody
reloads anything.

There is a **Live / Syncing / Paused / Offline** pill in the top bar. It is
there because "the board hasn't changed in a while" and "this tab stopped
listening an hour ago" look exactly the same, and only one of them is fine.
`Paused` is the fourth state for the same reason: a tab that stopped on purpose
must not be reported as broken.

### Why polling, when a socket is obviously nicer

Because the socket is what ran the previous host out of free tier, and it would
have done worse here.

A WebSocket is the better design when the server is a process that is running
anyway. This one isn't: it is a function that exists only while it is handling a
request. A held-open connection pins an instance for its whole lifetime, and
Vercel bills provisioned memory for exactly that — 360 GB-hrs a month at a fixed
2 GB, which is about 180 instance-hours. One tab left open around the clock
would spend the entire month's allowance in roughly a week.

The previous host failed the same way for a different reason. Its free tier
billed *instance-hours* and spun a service down after 15 minutes idle — but the
socket's own 30-second heartbeat is inbound traffic, so a tab sitting open kept
the instance awake permanently and burned all 750 hours.

A poll costs something only when it happens, which turns "don't be wasteful"
into something the client can actually enforce:

- **Unfocused tab → stop immediately.** Nobody is reading it.
- **Focused but untouched for 8 minutes → stop.** The tab in the background of
  somebody's afternoon is the expensive case, and the one that looks active.

Coming back — focus, a click, a keypress, a scroll — resumes and polls at once.
Vercel does now support WebSockets, so this is a cost decision rather than a
capability one.

### The poll carries notifications, not data

An event says *what changed* and the client refetches the affected endpoint. It
does not ship the new leaderboards down the wire, which would put a second copy
of derived state in flight and let two races arriving out of order leave a board
wrong — the same drift [the data model](#how-the-data-model-works) exists to
avoid. A refetch always lands on the current aggregation.

The one exception is the winner block on `game:recorded`: the celebration needs
a name, an accent and a win count at the instant it fires, and none of that is
recoverable from "something changed".

| Event | Sent when | Clients re-read |
| --- | --- | --- |
| `game:recorded` | a race is recorded | boards, roster, open profiles — and the flyby runs |
| `game:updated` | an admin corrects a race | boards, roster, race log, open profiles — no flyby |
| `game:deleted` | an admin deletes a race | boards, roster, race log, open profiles |
| `roster:changed` | profile edit, admin-created or deleted racer, or a sign-in that claims a seat or reconciles a role | roster **and boards** — rows join the user document on read, so a rename changes every board |
| `puns:changed` | the puns editor | the ticker, and the editor in any other admin's tab |
| `metrics:changed` | a metric is added, retuned or removed | boards — a metric is a *column* |
| `achievement-rules:changed` | a badge rule changes | open profile pages; a retuned threshold can unlock a badge with no write to that racer |

### How a tab knows where it is

The server keeps a single document — `liveLog` — holding a monotonic `seq` and
the last hundred events. A tab sends the highest `seq` it has applied and gets
back everything after it. The sequence number is minted inside the same
aggregation-pipeline update that appends the event, so two concurrent writes can
never collide on one.

When a tab has no position yet, or has fallen further behind than the retained
history, the answer is `resync` instead: *I can't tell you what you missed, go
re-read everything.* A partial history would leave a board confidently wrong,
which is worse than a refetch. The client turns that into the same `live:hello`
frame the socket used to send on connect, so the handling is unchanged.

Each answer also carries the **deployment id**. A value the tab hasn't seen
before means a new version shipped, which is the cue to go looking for a new
bundle. That used to be a per-boot uuid, which on a serverless runtime would
change on every cold start and cry wolf.

### What it is not

- **Not a Mongo change stream.** Writes that don't go through the API — `npm run
  seed`, an edit in the Atlas console — are still invisible. What *did* improve:
  the log is shared state rather than one process's memory, so a second
  instance's traffic is visible, which it never was before.
- **Not a socket, and not authenticated separately.** The WebSocket had to
  authenticate its own upgrade by hand (a browser can't set headers on a
  handshake) and check `Origin` explicitly, because a handshake isn't subject to
  CORS. As an ordinary guarded `GET` both of those special cases disappear.

### What it costs on the free plan

A poll is a small `findOne` on `_id`, and most of them return nothing. Ten
people using the app for an hour a day comes to roughly 108k invocations a
month against an allowance of 1M — and an idle tab contributes nothing at all,
which is the entire point of the two rules above.

### A tab's own echo

Each tab sends an `X-Scrapyard-Client` id on every mutating request, and the
server records it on the resulting event as `origin`. A tab ignores its own echo
only for `game:recorded`, because `POST /scores/record` answers with the three
recomputed boards and the client writes those straight in — re-running the flyby
would fire it twice.

Every other event is processed even in the tab that caused it: `origin` says who
sent the request, not that they learned the whole result. `DELETE
/admin/games/:id` answers with `{ deletedId, dayKey, recomputedGames }` and no
boards at all, so an admin who deletes a race needs that event as much as anyone
else does.

The id is **per tab, not per user** — somebody scoring a race on their phone
must still see it land on the laptop they left open.

---

## Architecture

```
  anonymous                              authenticated
      │                                        │
      ▼                                        ▼
  GET /login                               GET /
  ┌──────────────────────┐          ┌──────────────────────┐
  │ server-rendered HTML │          │ apps/web — React 18  │
  │ inline CSS + SVG     │          │ withheld until the   │
  │ ~16 KB, no bundle    │          │ session cookie is    │
  │                      │          │ valid · installable  │
  └──────────┬───────────┘          └──────────┬───────────┘
             │                                 │  /api/*
             │                                 │  /api/live/events ──► polled
             └──────────────┬──────────────────┘
                  ┌─────────▼──────────────────────┐
                  │ Vercel Function (fra1)         │
                  │ Nest serves all three          │
                  │ Google OAuth → JWT cookie      │
                  └─────────────┬──────────────────┘
                                │  TLS, over the public internet
                  ┌─────────────▼──────────────────┐
                  │ MongoDB Atlas M0 (Frankfurt)   │
                  │ users · wins · content         │
                  └────────────────────────────────┘
```

One origin, one function. `mountSpa` checks the session cookie *before* it will
hand over `apps/web/dist`, so an anonymous visitor gets the 16 KB login page and
never sees the application bundle at all. Nothing is served from Vercel's CDN,
because the CDN answers from the filesystem before routing reaches that check —
which is why `public/` is empty and the bundle is read by the function instead.

### Repo layout

One `package.json`, one `node_modules`, no workspaces. `apps/*` and
`packages/*` are plain folders with their own tsconfig, joined by a `paths`
mapping.

```
package.json           the only manifest
tsconfig.base.json     shared options + the @scrapyard/shared path mapping
vercel.json            the deployment: build, region, rewrite, includeFiles
api/index.js           the Vercel entrypoint — plain JS on purpose
public/                deliberately empty; see its README
.node-version          the Node version for local tooling
apps/
  api/                 NestJS
  web/                 React + Vite
packages/
  shared/src/index.d.ts  domain types, imported by both
```

`@scrapyard/shared` is a **declaration file** containing only types. That means
imports of it erase at compile time — no runtime resolution, no alias rewriting,
no bundler — and TypeScript exempts `.d.ts` from the `rootDir` check, so the API
still emits a flat `dist/main.js`. Every import site uses `import type`
deliberately: esbuild transpiles file-by-file and cannot tell a type import from
a value one.

### Who can sign in

Locked to `ALLOWED_WORKSPACE_DOMAINS`. The check happens twice — `hd` asks
Google to pre-filter the account chooser, and `GoogleStrategy.validate()`
re-derives the domain from the OAuth-verified address and rejects anything off
the list. The `hd` hint is trivially bypassable; the server-side check is what
enforces it. Unverified Google addresses are rejected too, failing *closed*.

The API refuses to boot if the domain list is empty. There is no open sign-in
mode to fall into by accident.

### Who is an admin

`ADMIN_EMAILS` is the single source of truth, **reconciled on every login**:

| Situation | Result |
| --- | --- |
| Listed in `ADMIN_EMAILS` | promoted at next login |
| Not listed, list is set | demoted at next login |
| List is empty | first racer to sign in becomes admin, with a loud warning |

Sign-up order is irrelevant, and hand-editing `role` in Mongo won't survive that
user's next login.

---

## Installing it (the PWA)

The app is installable on a desktop or a phone home screen: a manifest, a set of
icons, and a hand-written service worker in
[`apps/web/public/sw.js`](apps/web/public/sw.js) — no build plugin.

All of it (`/manifest.webmanifest`, `/sw.js`, `/icons/*`) resolves **before** the
session gate in `mountSpa`, because the browser fetches those without carrying
our cookie. The worker itself registers in production only; in development it
would fight Vite's HMR and cache stale modules.

### What the worker will and won't do

| | |
| --- | --- |
| `/api/*` and any non-GET | never touched. Scores must be live, caching a mutation would be a bug, and the live poll lives under `/api` |
| `/login` and its media | never touched. It must never be served from cache to somebody who has since signed in, and its background video is far too big to keep |
| navigations | network-first, falling back to the cached app shell — a flaky link opens the app instead of the browser's dinosaur |
| everything else | stale-while-revalidate: instant from cache, refreshed behind you. Safe because the bundle's filenames are content-hashed |

Two rules exist because breaking them is subtle and the symptom is bizarre:

- **The install list is added one file at a time.** `cache.addAll` is atomic, so a
  single missing file rejects the whole install, the worker never activates, and
  the app quietly stops being installable at all — which is exactly what a
  reference to a nonexistent icon used to do here.
- **Nothing that comes back as HTML is cached under the URL that asked for it.** A
  plain `fetch('/')` is not a *navigation*, so it takes the asset path — and with
  the session gone it follows its 302 and returns a perfectly `ok` login page,
  which then overwrites the app shell. The same goes for any unknown path, which
  the server answers with `index.html` via the SPA fallback.

### Updating a tab nobody reloads

An installed PWA can sit open for days, so a deploy has to reach it by itself.
[`apps/web/src/lib/pwa.ts`](apps/web/src/lib/pwa.ts) looks for a new worker when
the tab becomes visible, on a 30-minute timer, and the moment the live poll
returns a deployment id it hasn't seen — the earliest signal that a deploy
landed. The new worker calls `skipWaiting()`, claims its clients, and the page
reloads itself once onto the new bundle.

### Offline

Honestly: barely. Every board is an aggregation computed on read, so there is no
meaningful cached view of one. The worker gets the app *open* offline; the boot
then says so and retries itself when the link comes back.

### Push notifications

Optional, and off by default until `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are set
(see `apps/api/.env.example` — generate the pair with `npx web-push generate-vapid-keys`).
Configured, a racer can flip a toggle on their own profile page to get a push
whenever a race is recorded; the toggle is per-browser, not per-account, so
enabling it on a phone doesn't opt in a laptop too, and vice versa.

The subscription itself lives in `pushSubscriptions` (`_id` is the push
service's own endpoint URL — already a unique key, so there's nothing else to
generate). [`apps/api/src/push/push.service.ts`](apps/api/src/push/push.service.ts)
sends and self-heals: a 404/410 from the push service means that subscription
is gone for good (uninstalled, permission revoked at the OS level), so it's
deleted rather than retried forever. The service worker's `push` and
`notificationclick` handlers live at the bottom of
[`apps/web/public/sw.js`](apps/web/public/sw.js).

**iOS needs the app installed to the home screen first** (iOS 16.4+) — Safari
itself does not support Web Push, only a standalone home-screen app does. The
toggle detects this and won't offer to subscribe from inside Safari.

### iOS

The notch is handled — `viewport-fit=cover`, a translucent status bar, and chrome
that pads itself by `env(safe-area-inset-*)` (see `--safe-top` in
[index.css](apps/web/src/index.css)). Those three go together; change one and the
other two are wrong.

**Signing in from an installed iOS app is the rough edge.** Google's consent
screen is outside the manifest scope, so iOS hands it to Safari, and a home
screen web app doesn't share Safari's cookie jar — so the sign-in can complete
in the wrong place and the installed app still shows the wall. The session lasts
30 days, so this is a first-run problem rather than a daily one; if it bites, use
the app in Safari for that sign-in. Android and desktop Chrome keep the whole
flow inside the app.

**Maskable icon.** `arthur-maskable-512.png` is the same art padded onto the void
background, because Android crops a maskable icon to a circle and the unpadded
one loses the BlazeRush logo off the top. If you replace the art, pad it: keep
everything that matters inside the middle ~60%.

---

## Known trade-offs

**Cold starts.** There is no always-running process, so the first request after
a quiet spell builds the Nest DI graph and opens an Atlas connection before it
can answer — roughly a second. Fluid compute keeps an instance warm through a
burst, so this is paid once rather than per request, and nothing is lost because
all state is in Atlas. Deliberately not fixed by pinging: a keep-warm loop
spends the monthly allowance to save one person one second.

**No disk.** The filesystem is read-only apart from `/tmp`, and nothing survives
between invocations. This app never writes to disk; the zip export is streamed
straight to the response.

**The 4.5 MB body cap.** A hard platform limit in both directions. It bounds
avatar uploads, the base64 audio sent to voice entry, and the database export —
the last of which was 139 KB at the time of the migration, so there is room, but
it is a ceiling rather than a soft limit and it fails abruptly with a 413.

**Atlas is over the public internet.** Functions have no fixed egress address
and no private link to a third party on this plan, so the connection is TLS over
the open net with credentials as the gate. Keep Atlas in Frankfurt, and the
function in `fra1`, to keep the round trip short.

**Node version pinning.** `.node-version` pins `22.22.0` for local tooling, and
`package.json` carries a bounded `engines` range. Vercel reads the range rather
than the file, so an unbounded one would silently move to the newest Node
release under you.

**Self-hosting the login video** works — Nest serves it from
`apps/api/public/login/` before the session gate — but it's a large binary in
Git, it has to be listed under `functions.includeFiles` to reach the
deployment, and every byte counts against the function's transfer allowance. The YouTube embed is the default
and costs you nothing. See
[`apps/api/public/login/README.md`](apps/api/public/login/README.md).

---

## Scripts

```bash
npm run dev          # Vite 5173 + Nest 3000, hot reload
npm run preview      # build both, Nest serves everything on 3000
npm run build        # tsc for the API, vite for the bundle
npm run typecheck    # API and web, no emit
npm run seed         # demo racers and ~90 days of scattered wins
npm run smoke        # full end-to-end suite (needs MONGODB_URI)
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| First request after a quiet spell takes ~1s | Cold start: Nest's DI graph plus an Atlas handshake | Working as designed. Don't add a keep-warm ping — it spends the monthly allowance to save one second |
| `MONGODB_URI is not set` | Missing env var | Set it locally in `apps/api/.env`, on Vercel under Settings → Environment Variables |
| Mongo connection times out | Atlas Network Access | Add `0.0.0.0/0` |
| Mongo auth fails with a valid password | Special characters | URL-encode the password, or regenerate it alphanumeric |
| Build fails on `tsc: not found` | `NODE_ENV=production` set as a *build* variable, pruning devDependencies | Remove it; the platform sets it at runtime for you |
| `Invalid Origin: URIs must not contain a path` | Callback pasted into **JavaScript origins** | Move it to **Authorised redirect URIs**; leave origins empty |
| `redirect_uri_mismatch` | Console URI ≠ `GOOGLE_CALLBACK_URL` | Make them byte-identical, including scheme and trailing path |
| `Only @cytactic.com accounts can access Scrapyard` | Signed in with a personal account | Working as designed |
| Bounced to `/login` right after signing in | `JWT_SECRET` changed, or `WEB_ORIGIN` set | Clear cookies; leave `WEB_ORIGIN` unset |
| Sent back to an `http://` URL after signing in | `TRUST_PROXY` unset, so `request.protocol` reads the plain-HTTP hop from the edge | Set `TRUST_PROXY=true` |
| Cookie warning in the logs | `NODE_ENV` overridden | Unset it, or set `COOKIE_SECURE=true` |
| Admin page says admin-only | Not in `ADMIN_EMAILS` | Add it, then **sign out and back in** — the role reconciles at login |
| `the 'bg-void' class does not exist` | Tailwind config not found | Configs are `.mjs` with absolute paths; the build runs from the repo root |
| `Cannot find module @rollup/rollup-*` | npm optional-dependency bug | `rm -rf node_modules package-lock.json && npm install` |
| Top bar says **Paused**, boards never move | Working as designed — the tab is unfocused, or has been untouched for 8 minutes | Click it. See [Live updates](#live-updates) for why an idle tab stops |
| Top bar says **Offline**, boards never move | The poll is failing | `curl /api/live/events` with a session cookie. It retries with backoff on its own, so a stuck "Offline" with the site otherwise working means the endpoint is returning an error — check the function logs |
| Top bar says **Offline** and nothing recovers | The session expired while the tab sat idle | The poll stops for good on a 401 rather than hammering a dead session. Reload; you'll be sent to `/login` |
| Everything refetches on every poll | The client is being told to resync each time | Its cursor is outside the retained history (100 events) or ahead of it. A log that was dropped and recreated under a long-lived tab does this; a reload clears it |
| Installed app won't sign in on iOS | Google's consent screen leaves the manifest scope and iOS hands it to Safari, which has its own cookie jar | Sign in using the app in Safari; see [Installing it](#installing-it-the-pwa) |
| A deploy doesn't reach a long-open tab | Service worker didn't pick up the new build | It checks on visibility, every 30 minutes, and when the poll returns a new deployment id. Confirm `sw.js` is being served with `Cache-Control: max-age=0` (Express's default here) |
| Offline launch shows the login wall | An old service worker cached `/login` as the app shell | Fixed in `scrapyard-v3`; bumping the cache name is what discards a poisoned shell |

---

BlazeRush is © Targem Games. This is an unaffiliated, internal fan-themed tool.
Arthur is an original drawing.
