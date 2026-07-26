# Running Scrapyard from scratch

A first-run walkthrough. Budget ~10 minutes, almost all of it in the Google
Cloud Console.

> **Where you already are.** `npm install` has run, `apps/api/.env` exists with
> everything filled in *except* the two Google values, and the database is
> seeded with 8 demo racers. So you can skip to [Step 2](#step-2-create-the-google-oauth-client).

---

## Step 1 — Prerequisites

```bash
node -v      # need >= 20 ; you have 22
npm -v
```

From the repo root:

```bash
cd ~/private/SCRAPYARD-HARD-V
npm install
```

---

## Step 2 — Create the Google OAuth client

This is the only real work, and the only thing currently blocking you. Sign-in
is strict Google SSO — there is no bypass or dev-login mode, so the API will
refuse to boot without these two values.

### 2a. Pick a project

[console.cloud.google.com](https://console.cloud.google.com) → project picker
(top bar) → **New Project**. Name it anything (`scrapyard`). Make sure it's
inside the **cytactic.com organisation**, not a personal account — that's what
makes the *Internal* option available in the next step.

### 2b. Configure the consent screen

**APIs & Services → OAuth consent screen**

| Field | Value |
| --- | --- |
| User type | **Internal** |
| App name | `Scrapyard` |
| User support email | your address |
| Developer contact | your address |

**Internal** means only `@cytactic.com` accounts can even reach the consent
screen. That's belt-and-braces with our own server-side domain check — Google
filters the front door, we verify the token regardless.

Internal apps need **no verification and no scope review**, because the three
scopes we request (`openid`, `email`, `profile`) are all non-sensitive. Nothing
to submit, no waiting.

### 2c. Create the credentials

**APIs & Services → Credentials → + Create Credentials → OAuth client ID**

Application type: **Web application**. Name it anything.

Then there are **two URL boxes, and they are not interchangeable** — this is the
easiest thing in the whole setup to get wrong:

| Box | What to put | Why |
| --- | --- | --- |
| **Authorised JavaScript origins** | **leave empty** | Accepts a bare origin only — no path, no trailing slash. Paste a URL with a path here and you get `Invalid Origin: URIs must not contain a path or end with "/"`. We don't need this at all: the flow is a server-side redirect, not a browser-side token grab. |
| **Authorised redirect URIs** | `http://localhost:3000/api/auth/google/callback` | This is the one that matters. Google sends the user back here after consent. |

If you'd rather not leave origins blank, the only legal value is
`http://localhost:3000` — origin only.

The redirect URI must match `GOOGLE_CALLBACK_URL` **byte for byte** — scheme,
host, port, full path, no trailing slash. A mismatch gives you
`redirect_uri_mismatch`, which at least says so plainly.

Hit **Create** and keep the panel open — you need both values next.

---

## Step 3 — Paste the two values

```bash
open -e apps/api/.env      # or $EDITOR apps/api/.env
```

Fill only these two:

```dotenv
GOOGLE_CLIENT_ID=<the long ...apps.googleusercontent.com string>
GOOGLE_CLIENT_SECRET=<GOCSPX-...>
```

Everything else is already set for local use:

```dotenv
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback
ALLOWED_WORKSPACE_DOMAINS=cytactic.com     # only *@cytactic.com may sign in
ADMIN_EMAILS=amit@cytactic.com             # you are admin, whenever you first log in
JWT_SECRET=<already generated>
WEB_ORIGIN=http://localhost:5173           # dev only — see the note in Step 5
SCRAPYARD_TIMEZONE=Asia/Jerusalem          # when "today" flips for the daily board
```

If you'd rather rotate the session secret:

```bash
openssl rand -hex 32
```

Changing `JWT_SECRET` invalidates every existing session — you'll be bounced to
`/login` once, which is expected, not a bug.

---

## Step 4 — Seed some data (already done)

```bash
npm run seed
```

Writes 8 demo racers with ~90 days of scattered wins, so the leaderboard,
streaks and achievements have something to show. Safe to re-run; it overwrites
the `seed-*` files and rebuilds every derived board.

To clear them out later:

```bash
rm apps/api/database/users/seed-*.json
# then, signed in as an admin:
curl -X POST 'http://localhost:3000/api/scores/rebuild?confirm=yes' \
     -H "Cookie: scrapyard_session=<your cookie>"
```

Seeded racers **cannot sign in** — they have no real Google account behind them.

---

## Step 5 — Run it

Two modes. Both work; they differ only in port count and hot reload.

### Day to day

```bash
npm run dev
```

→ **http://localhost:5173**

Vite owns 5173 for hot module reload and proxies `/api`, `/login` and
`/login-assets` to Nest on 3000. Two ports, but the browser is same-origin, so
the session cookie behaves exactly as in production.

### To see what actually deploys

```bash
npm run preview
```

→ **http://localhost:3000**

Builds both apps, then Nest serves everything on one port. Use this to verify
the real security boundary: under `npm run dev` Vite hands out the JS bundle to
anyone, so only `preview` demonstrates Nest actually withholding it.

> If you use `preview`, set `WEB_ORIGIN=` (empty) in `.env` first, so the
> post-login redirect stays on :3000 instead of bouncing you to :5173.

---

## Step 6 — Sign in

1. You land on `/login` — the server-rendered wall, with BlazeRush footage
   behind it.
2. **Continue with Google** → pick your `@cytactic.com` account.
3. You're redirected into the app, and because `ADMIN_EMAILS` lists you, you're
   an admin from the first login.

Try, in order:

- **Add Score** on the main page — pick a winner, hit the submit button, and
  watch Arthur cross the screen. Check the tabs: all three boards updated.
- **Racers** in the side menu, then click yourself → edit your profile.
- **Admin** → the searchable card grid. Edit a pun and watch the top ticker
  change. Then hit **Export Database** for a zip of every JSON file.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing required environment variable GOOGLE_CLIENT_ID` at boot | `.env` blank or in the wrong place | It must be `apps/api/.env`, not the repo root |
| Google: `Invalid Origin: URIs must not contain a path or end with "/"` | The callback URL was pasted into **Authorised JavaScript origins** | Move it to **Authorised redirect URIs**. Leave origins empty, or use `http://localhost:3000` with no path |
| Google: `redirect_uri_mismatch` | Console redirect URI ≠ `GOOGLE_CALLBACK_URL` | Make both exactly `http://localhost:3000/api/auth/google/callback` |
| `Only @cytactic.com accounts can access Scrapyard` on the login page | Signed in with a personal Google account | Use your work account. Working as designed. |
| Bounced to `/login` immediately after signing in | `JWT_SECRET` changed, or you're on `preview` with `WEB_ORIGIN` still pointing at :5173 | Clear cookies for localhost; set `WEB_ORIGIN=` empty for `preview` |
| Admin page says admin-only | Your email isn't in `ADMIN_EMAILS` | Add it, then **sign out and back in** — the role reconciles at login |
| Login page background is black | YouTube embed blocked on your network | Expected; drop a `background.mp4` into `apps/api/public/login/` — see that folder's README |
| `Cannot find module @rollup/rollup-*` | npm's optional-dependency bug across platforms | `rm -rf node_modules package-lock.json && npm install` |
| `the 'bg-void' class does not exist` | Tailwind config not found | Configs are `.mjs` in `apps/web/`; the build runs from the repo root, so paths must stay absolute |
| `Parameter decorators only work when experimental decorators are enabled` | Ran the API through `tsx`/esbuild | Use `ts-node` — esbuild can't emit the metadata Nest's DI needs |

### Verify the whole thing without a browser

```bash
DATABASE_DIR=/tmp/scrapyard-smoke \
ALLOWED_WORKSPACE_DOMAINS=cytactic.com ADMIN_EMAILS=amit@cytactic.com \
GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy \
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback \
JWT_SECRET=smoke SCRAPYARD_TIMEZONE=UTC \
npm run seed && npm run smoke
```

147 assertions, no browser and no real Google credentials needed. Run
`npm run build` first if you want the SPA-gate checks included rather than
skipped.

---

## Then: Docker

Once local works, the container is the same thing on one port:

```bash
cp apps/api/.env .env          # compose reads .env from the repo ROOT
docker compose up --build
```

→ http://localhost:3000/login

Add `http://localhost:3000/api/auth/google/callback` to the Console's authorised
redirect URIs too (you can list several), or change `GOOGLE_CALLBACK_URL` to
match whichever host you're serving from.

For a real deployment, follow **[DEPLOY.md](DEPLOY.md)** — GCP always-free
`e2-micro` + Cloudflare Tunnel, with the billing safety net first. The short
version: leave `WEB_ORIGIN` empty, set `NODE_ENV=production` and `TRUST_PROXY=1`,
point `GOOGLE_CALLBACK_URL` at your HTTPS host, and **run one replica only**.
