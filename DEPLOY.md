# Deploying Scrapyard

One always-free Google Cloud `e2-micro` running the container, published on your
Cloudflare domain over TLS. **Cost: $0.00/month.**

There are two paths. Both end up in the same place.

| | |
| --- | --- |
| **[Path A — OpenTofu](#path-a--opentofu-recommended)** | One `tofu apply`. Provisions the VM, network, secrets, budget and killswitch; the VM then installs Docker and starts the app itself. |
| **[Path B — by hand](#path-b--by-hand)** | Click through the console. Slower and easier to get wrong, but worth reading once to understand what Path A is doing. |

Either way, **read [Part 1](#part-1--never-pay-by-mistake) first.** It's the boring
part and it's the part that protects you.

---

## Part 0 — Three different "frees", because they're easy to confuse

| | What it is | Can it charge you? |
| --- | --- | --- |
| **Free Trial** | $300 credits, 90 days | **No.** The account auto-closes when credits or days run out. You're never charged without manually clicking Upgrade. |
| **Always Free** | Permanent monthly quotas — the `e2-micro`, 30 GB disk, 1 GB egress | Only if you exceed them |
| **Paid account** | What you get after clicking Upgrade | **Yes** |

The part nobody mentions: **to keep an Always Free VM past the trial you must
upgrade to a paid account.** If you don't, billing is disabled, you get 30 days'
grace, then your resources are permanently deleted.

So the end state is a paid account running only free resources. Charges are
*possible*. Hence Part 1.

---

## Part 1 — Never pay by mistake

Three layers. Only the third actually stops money.

### Layer 1 — provision only free-eligible resources

The traps, in the order people hit them:

| Trap | Why it bites |
| --- | --- |
| **Balanced boot disk** | The console's default is `pd-balanced`. Always Free covers `pd-standard` only. This is the most common way people pay for a "free" VM. |
| **Wrong region** | Only `us-west1`, `us-central1`, `us-east1`. `europe-west1` looks sensible and bills you. |
| **A second `e2-micro`** | The allowance is one per *billing account*, not per project. |
| **Snapshots** | Not in the free tier. Use the app's export instead. |
| **A reserved static IP** | Free while attached to a running instance, charged when idle. |

Path A blocks every one of these with `validation` blocks in
[`infra/variables.tf`](infra/variables.tf) — `tofu plan` fails rather than
quietly billing you. On Path B you have to be careful by hand.

### Layer 2 — a $1 budget

**Billing → Budgets & alerts → Create budget**

| Field | Value |
| --- | --- |
| Scope | this project only |
| Amount | **$1** |
| Thresholds | 50%, 90%, 100% of actual spend |
| Email | you |

Why $1? Correct spend here is **$0.00 forever**. Any non-zero figure means
something is misconfigured, and you want to hear about it while it's still worth
a dollar.

Also **untick "Include credits in cost"** (Path A sets
`credit_types_treatment = "EXCLUDE_ALL_CREDITS"`). Left on, trial credits are
subtracted from the reported total, so the budget reads ~$0 and never fires while
you burn credits on something broken.

### Layer 3 — the killswitch

> **A budget alert does not stop anything.** Google's docs: budgets *"don't
> automatically prevent the use or billing of your services when the budget
> amount or threshold rules are met or exceeded."*

An alert is an email. If something runs away at 3am you get an email at 3am and
the meter keeps running. The killswitch is a Cloud Function subscribed to the
budget's Pub/Sub topic that **detaches the billing account** from the project.

Path A deploys it — see [`infra/billing.tf`](infra/billing.tf) and
[`infra/killswitch/index.js`](infra/killswitch/index.js). Set
`enable_billing_killswitch = false` to skip it.

> ### ⚠️ It is destructive
>
> Detaching billing **stops the VM**, and Google eventually **deletes the
> persistent disk**. It protects your wallet by destroying the deployment.
>
> 1. **Test it immediately after the first apply**, while there's nothing to lose:
>    ```bash
>    cd infra && eval "$(tofu output -raw killswitch_test_command)"
>    gcloud functions logs read scrapyard-billing-killswitch --gen2 --region=us-central1 --limit=10
>    ```
>    You want `KILLSWITCH FIRED`. Then **re-attach billing** in the console
>    (Billing → your project → Change billing account).
> 2. **Keep backups** — see [Backups](#backups).
>
> If you'd rather never risk the data, disable it. But then nothing halts
> spending; you're relying on noticing an email.

---

## Prerequisites — the two things automation can't do

Both need a browser. Neither has a usable API.

### 1. The Google OAuth client

Follow [RUNNING.md § 2c](RUNNING.md#2c-create-the-credentials). The one thing
that catches everyone: the callback URL goes in **Authorised redirect URIs**, not
**Authorised JavaScript origins** (which rejects anything containing a path).

Add the production URI alongside the localhost one — a client holds several:

```
https://scrapyard.cytactic.com/api/auth/google/callback
```

### 2. The Cloudflare Tunnel

Zero Trust → **Networks → Tunnels → Create a tunnel → Cloudflared**. Name it
`scrapyard`. Copy the **token** (the string after `--token`); skip the install
command, compose runs `cloudflared` for you.

Then add a **Public Hostname**:

| Field | Value |
| --- | --- |
| Subdomain | `scrapyard` |
| Domain | `cytactic.com` |
| Type | `HTTP` |
| URL | `api:3000` |

`api:3000` is the compose **service name**, not `localhost` — `cloudflared` runs
in its own container. `HTTP` is correct even though users arrive over HTTPS: TLS
terminates at Cloudflare's edge, and the hop inside the Docker network needs no
certificate of its own.

Cloudflare creates the DNS record.

#### Why a tunnel rather than opening a port

```
   browser                Cloudflare edge              your VM
  ┌──────────┐           ┌──────────────┐          ┌──────────────────┐
  │ https:// │──────────▶│ TLS, DDoS     │◀─────────│ cloudflared      │
  │ scrapyard│           │               │ outbound │       ↓          │
  │ .cytactic│           │               │  only    │ scrapyard-api    │
  │ .com     │◀──────────│               │─────────▶│ + volume         │
  └──────────┘           └──────────────┘          └──────────────────┘
```

`cloudflared` dials **out**. Nothing dials in: no port forwarding, no inbound
firewall rule, and the VM's address is never exposed. It also gives you the TLS
certificate Google OAuth requires, which is otherwise the one genuinely
unavoidable cost of going public.

---

## Path A — OpenTofu (recommended)

Everything lives in [`infra/`](infra/). Full instructions, prerequisites and
day-to-day commands are in **[infra/README.md](infra/README.md)**; the short
version:

```bash
gcloud auth login && gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID

# Two APIs must exist before the first plan — a genuine chicken-and-egg, because
# a data source is read at plan time before anything can be enabled.
gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com

# State holds your client secret and tunnel token in plaintext. Versioned bucket.
gcloud storage buckets create "gs://$PROJECT_ID-tofu-state" \
  --location=us-central1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$PROJECT_ID-tofu-state" --versioning

cd infra
cp backend.hcl.example backend.hcl            # your bucket name
cp terraform.tfvars.example terraform.tfvars  # your values — gitignored

tofu init -backend-config=backend.hcl
tofu plan            # check the free_tier_summary output
tofu apply
```

Then watch the VM build itself — slow on 1 GB of RAM, which is why the startup
script adds swap:

```bash
eval "$(tofu output -raw ssh_command)"     # SSH via IAP; port 22 isn't public
sudo journalctl -u google-startup-scripts -f
```

`tofu output` also prints the exact OAuth redirect URI and the tunnel hostname
target, so you can copy them straight into the two prerequisite steps above.

**What it manages:** a purpose-built VPC (not the permissive `default` network),
IAP-only SSH, the `e2-micro` pinned to the free shape, a least-privilege service
account, Secret Manager entries, the startup script, the budget, and the
killswitch.

**What it doesn't:** the OAuth client and the Cloudflare tunnel — the two
prerequisites above.

---

## Path B — by hand

Only worth doing if you want to understand Path A, or you'd rather not run
OpenTofu.

### Create the VM

**Compute Engine → VM instances → Create instance**

| Setting | Value |
| --- | --- |
| Region | `us-central1` (or `us-west1` / `us-east1`) |
| Machine | **E2 → `e2-micro`** |
| Boot disk type | **Standard persistent disk** — ⚠️ the default is Balanced, which is billed |
| Boot disk size | 30 GB |
| Image | Debian 12 |
| Provisioning | Standard (not Spot) |

### Install Docker and deploy

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# 1 GB RAM runs the container fine but can't build the image without swap.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo apt-get update && sudo apt-get install -y git
git clone <your-repo-url> scrapyard && cd scrapyard
```

Write `.env` **at the repo root** — compose reads it from there, not from
`apps/api/`:

```dotenv
GOOGLE_CLIENT_ID=<yours>
GOOGLE_CLIENT_SECRET=<yours>
GOOGLE_CALLBACK_URL=https://scrapyard.cytactic.com/api/auth/google/callback
JWT_SECRET=<openssl rand -hex 32>

ALLOWED_WORKSPACE_DOMAINS=cytactic.com
ADMIN_EMAILS=amit@cytactic.com

NODE_ENV=production      # turns on Secure cookies
TRUST_PROXY=1            # Cloudflare terminates TLS
WEB_ORIGIN=              # EMPTY — relative redirects, CORS off
SCRAPYARD_TIMEZONE=Asia/Jerusalem

LOGIN_BACKGROUND_YOUTUBE_ID=xt_1gJkjdec
TUNNEL_TOKEN=<from the prerequisites>
```

Three of those do more than they look:

- **`NODE_ENV=production`** is what sets `Secure` on the session cookie. Without
  it the app warns at boot and ships the cookie unprotected.
- **`TRUST_PROXY=1`** makes `request.protocol` and `request.ip` describe what the
  browser did, not the plain-HTTP hop from `cloudflared`.
- **`WEB_ORIGIN=`** empty keeps post-login redirects relative (so they work
  behind any hostname) and disables CORS entirely.

Then:

```bash
chmod 600 .env
docker compose --profile tunnel up -d --build
docker compose logs -f cloudflared          # want "Registered tunnel connection"
docker compose exec api node dist/database/seed.js   # optional demo racers
```

### Lock the box down

```bash
sudo apt-get install -y ufw
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw --force enable
```

The container binds to `127.0.0.1` anyway, so it was never externally reachable.

---

## Part 2 — What can still cost money

With the above, the only realistic overage is **egress: 1 GB/month** from North
America. All traffic leaves the VM toward Cloudflare, so it counts.

| Asset | Size | Note |
| --- | --- | --- |
| JS bundle | 77 KB gzipped | cached `immutable`, fetched once per deploy |
| CSS | 8 KB gzipped | same |
| Login page | 16 KB | uncached, but tiny |
| API responses | a few KB | JSON only |
| Login background | **0 KB** | served by YouTube, not by you |

Ten people checking it a few times a day is roughly 50–100 MB/month.
Comfortable.

**The one thing that would blow it:** self-hosting `background.mp4`. At 2 MB
uncached, ~500 login views consumes the entire month. On this tier keep the
YouTube embed, or set `LOGIN_BACKGROUND_YOUTUBE_ID=none`.

Check monthly — Billing → Overview should read **$0.00**.

---

## Restricting access by IP

Optional. Two places to do it, but read the trade-off.

**At Cloudflare's edge** (blocks traffic before it reaches you) — Zero Trust →
**Access → Applications** → your app → policy: *Allow · IP ranges ·
`<office IP>/32`*. Or without Zero Trust: **WAF → Custom rules** →
`(http.host eq "scrapyard.cytactic.com" and ip.src ne <office IP>)` → *Block*.

### The trade-off

An IP allowlist means **nobody can use it from home, from a phone, or on 5G.**
For an in-office leaderboard that may be exactly right. But you already have two
independent gates:

1. Google SSO restricted to `@cytactic.com`, re-verified server-side
2. An anonymous visitor gets a 16 KB login page and *nothing else* — no bundle,
   no API data

So this is defence in depth, not a missing control. Launch without it; add it if
you ever see sign-ins you don't recognise.

---

## Backups

The Docker volume **is** the database, and the killswitch can destroy it.

Path A installs a nightly tarball job at `/var/backups/scrapyard` — but that's on
the same disk, so it guards against application mistakes, not disk loss. For
anything you care about, use **Admin → Export Database** in the app, or pull the
tarballs off the box:

```bash
docker run --rm -v scrapyard_scrapyard-db:/data -v "$HOME:/backup" \
  alpine tar czf /backup/scrapyard-$(date +%F).tar.gz -C /data .
```

The volume name is prefixed by the directory compose ran in — check
`docker volume ls`.

Restore: stop the container, untar over the volume, start it, then
`POST /api/scores/rebuild?confirm=yes` as an admin. Strictly you only need
`users/` and `content/`; the rest is derived and the rebuild is authoritative.

---

## One replica, always

The JSON store is single-writer by design — one in-process mutex serialises the
five-file award cascade. Two containers on one volume would interleave writes.
`deploy.replicas` is pinned to 1 for that reason, and an `e2-micro` couldn't host
two anyway.

If Scrapyard ever outgrows that, the answer is a real database, not more
replicas.

---

## Why not somewhere else?

| Option | Verdict |
| --- | --- |
| **GitHub Pages** | No. Static files only — can't run Node, hold a secret, write to disk, set an httpOnly cookie, or withhold the bundle. |
| **Cloudflare Workers** | No. V8 isolates, not Node; no filesystem. Would mean rewriting the API and replacing the JSON store. |
| **Cloudflare Containers** | Runs, then loses your data. *"All disk is ephemeral; when a Container instance goes to sleep, the next time it is started it will have a fresh disk."* |
| **Cloud Run** | Same trap — ephemeral disk, silently resets on cold start unless you FUSE-mount GCS. |
| **Render free tier** | Sleeps after 15 min idle **and** has no persistent disk. |
| **Fly.io / Railway** | Both discontinued their free tiers. |
| **Oracle Cloud ARM** | Genuinely free and more powerful, but **halved in June 2026** to 2 OCPU / 12 GB, and A1 capacity is frequently unobtainable. A fine alternative if you get an instance. |
| **A machine you own** | Free, lowest latency, and the tunnel makes it publicly reachable. Best option *if* you have an always-on box. |

---

## Sources

- [Compute Engine free tier limits](https://cloud.google.com/free/docs/compute-getting-started)
- [Free Google Cloud features and trial offer](https://docs.cloud.google.com/free/docs/free-cloud-features)
- [Free Trial FAQs — no charge without upgrading](https://cloud.google.com/signup-faqs)
- [Budgets do not cap spending](https://docs.cloud.google.com/billing/docs/how-to/budgets)
- [Cloudflare Containers — ephemeral disk](https://developers.cloudflare.com/containers/faq/)
- [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
