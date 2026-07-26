# infra — OpenTofu for the GCP free tier

One `tofu apply` provisions the always-free `e2-micro`, its network, its secrets,
and the billing protection. The VM then installs Docker and brings Scrapyard up
on its own.

**Expected cost: $0.00/month.** Every variable that could break that has a
validation rule, so `tofu plan` fails rather than quietly billing you.

---

## What this does and doesn't do

**Manages:**

- a purpose-built VPC — no `default` network, so the only ingress is the one rule
  we declare
- firewall: SSH from Google's IAP range only, plus an explicit deny-all
- the `e2-micro`, pinned to `pd-standard` / 30 GB / a free region
- a least-privilege service account (**not** the default Compute SA, which holds
  project Editor)
- Secret Manager entries for the OAuth client, JWT secret and tunnel token
- a startup script that installs Docker, adds swap, fetches the secrets, clones
  the repo, runs `docker compose --profile tunnel up`, and sets up nightly backups
- a $1 budget with email alerts
- the billing killswitch — a Cloud Function that detaches billing if the budget
  is breached

**Does not manage** (both need a browser, neither has a usable API):

- the **Google OAuth client**. Create it per [RUNNING.md](../RUNNING.md), then pass
  the id and secret as variables.
- the **Cloudflare Tunnel and DNS record**. Create the tunnel, copy its token into
  `terraform.tfvars`, and point a Public Hostname at `api:3000`. Two minutes; see
  [DEPLOY.md](../DEPLOY.md).

---

## Prerequisites

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
```

Two APIs must be on **before** the first plan. OpenTofu enables the rest itself,
but it reads a `google_project` data source during *plan* — which happens before
anything can be enabled — so these two are a genuine chicken-and-egg:

```bash
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  serviceusage.googleapis.com
```

Create the state bucket. State holds your client secret, JWT secret and tunnel
token in plaintext, so this bucket is versioned and never public:

```bash
PROJECT_ID=your-project-id

gcloud storage buckets create "gs://$PROJECT_ID-tofu-state" \
  --location=us-central1 \
  --uniform-bucket-level-access \
  --public-access-prevention

gcloud storage buckets update "gs://$PROJECT_ID-tofu-state" --versioning
```

You also need `roles/billing.admin` on the billing account — the budget and the
killswitch's IAM binding both require it.

---

## Deploy

```bash
cd infra

cp backend.hcl.example backend.hcl              # set your bucket name
cp terraform.tfvars.example terraform.tfvars    # fill in — gitignored

tofu init -backend-config=backend.hcl
tofu plan        # read the free_tier_summary output
tofu apply
```

Then watch the VM bring itself up (the build is slow on 1 GB of RAM — swap is
doing the work):

```bash
eval "$(tofu output -raw ssh_command)"
sudo journalctl -u google-startup-scripts -f
```

`tofu output` also prints the exact OAuth redirect URI to register and the value
to enter as the tunnel's Public Hostname.

---

## ⚠️ The killswitch is destructive — test it first

A budget alert is only an email. Google's docs are explicit that budgets *"don't
automatically prevent the use or billing of your services."* The Cloud Function
is the only thing that actually halts spending, and it does so by **detaching the
billing account**, which stops the VM and eventually causes Google to **delete
the persistent disk**.

It protects your wallet by destroying the deployment. So:

1. **Test it while you have nothing to lose**, right after the first apply:

   ```bash
   eval "$(tofu output -raw killswitch_test_command)"

   gcloud functions logs read scrapyard-billing-killswitch \
     --gen2 --region=us-central1 --limit=10
   ```

   You want to see `KILLSWITCH FIRED`. Then **re-attach billing** in the console
   (Billing → your project → Change billing account) before continuing.

2. **Keep backups.** The startup script writes a nightly tarball to
   `/var/backups/scrapyard`, but that's on the same disk the killswitch destroys.
   For anything you care about, use the in-app **Admin → Export Database** card,
   or copy the tarballs off the box.

If you'd rather never risk the data, set `enable_billing_killswitch = false` —
but then accept that a misconfiguration bills you until you notice the email.

---

## Why each value keeps it free

| Setting | Value | If you change it |
| --- | --- | --- |
| `machine_type` | `e2-micro` | `e2-small` and up are billed. Validation blocks it. |
| `region` | `us-west1` / `us-central1` / `us-east1` | Anywhere else is billed. Validation blocks it. |
| `boot_disk_type` | `pd-standard` | **The console defaults to Balanced, which is billed.** Validation blocks it. |
| `boot_disk_size_gb` | ≤ 30 | 30 GB-months is the allowance. |
| External IP | ephemeral | Free while attached to a running free-tier instance. Needed for outbound only — the no-IP alternative requires Cloud NAT at ~$32/month. |
| Secret Manager | 4–5 secrets | 6 active versions are free. `deletion_policy = "DELETE"` stops old versions accumulating past that. |
| Egress | 1 GB/month | The real limit. This app uses ~50–100 MB. **Don't self-host `background.mp4`** — 2 MB uncached burns the month in ~500 views. |

The allowance is **one** `e2-micro` per *billing account*, not per project. If you
already run one elsewhere, this VM will be billed.

---

## Day-to-day

```bash
# SSH
eval "$(tofu output -raw ssh_command)"

# Redeploy the app after pushing (the startup script also re-runs on reboot)
cd /opt/scrapyard && sudo git pull && sudo docker compose --profile tunnel up -d --build

# Logs
sudo docker compose logs -f api
sudo docker compose logs -f cloudflared

# Seed demo racers
sudo docker compose exec api node dist/database/seed.js

# Confirm you're still at zero
gcloud billing projects describe YOUR_PROJECT_ID
```

### Changing the startup script

`compute.tf` sets `lifecycle { ignore_changes = [metadata_startup_script] }` so
editing the template doesn't silently replace the instance and lose the database
volume. To apply changes deliberately:

```bash
tofu apply -replace=google_compute_instance.scrapyard   # ⚠️ destroys the volume
```

Back up first. Usually you want to SSH in and pull instead.

---

## Teardown

```bash
tofu destroy
```

Removes the VM and its disk — **including the database**. Export first.

APIs are left enabled (`disable_on_destroy = false`); disabling them can break
unrelated things in the project, and an idle enabled API costs nothing.

---

## Notes

- **State contains secrets.** `terraform.tfvars`, `backend.hcl`, `*.tfstate` and
  `.build/` are all gitignored. Don't defeat that.
- **`tofu validate` was not run when this was written** — my sandbox couldn't
  install OpenTofu. HCL syntax, cross-file references, `count`/`for_each`
  indexing and the rendered startup script were all checked mechanically, but
  provider *schema* validation is on you. Run `tofu validate` before `apply`; if
  an argument name has drifted in a newer provider, that's where you'll see it.
- Provider is pinned to `hashicorp/google ~> 6.14`. `all_updates_rule` on
  `google_billing_budget` is the argument most likely to be renamed in a future
  major version.
