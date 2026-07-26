/**
 * Every variable that could cost money has a validation rule.
 *
 * That's deliberate: the goal isn't just "£0 today", it's making it awkward to
 * accidentally provision something billable six months from now. `tofu plan`
 * should fail loudly rather than quietly creating a Balanced disk.
 */

# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------

variable "project_id" {
  description = "GCP project id, e.g. scrapyard-prod."
  type        = string
}

variable "billing_account" {
  description = <<-EOT
    Billing account id, digits and dashes only, e.g. 01A2B3-4C5D6E-7F8G9H.
    Find it with: gcloud beta billing accounts list
  EOT
  type        = string

  validation {
    condition     = can(regex("^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$", var.billing_account))
    error_message = "Expected the bare id like 01A2B3-4C5D6E-7F8G9H, not the billingAccounts/ prefix."
  }
}

# ---------------------------------------------------------------------------
# Location — only three regions qualify for the always-free e2-micro
# ---------------------------------------------------------------------------

variable "region" {
  description = "Must be one of the three always-free regions."
  type        = string
  default     = "us-central1"

  validation {
    condition     = contains(["us-west1", "us-central1", "us-east1"], var.region)
    error_message = <<-EOT
      Compute Engine's always-free e2-micro exists ONLY in us-west1, us-central1
      or us-east1. Any other region is billed at the normal rate.
    EOT
  }
}

variable "zone" {
  description = "Zone within the region, e.g. us-central1-a."
  type        = string
  default     = "us-central1-a"
}

# ---------------------------------------------------------------------------
# The VM — pinned to the free-tier shape
# ---------------------------------------------------------------------------

variable "machine_type" {
  description = "Do not change. e2-micro is the only always-free machine type."
  type        = string
  default     = "e2-micro"

  validation {
    condition     = var.machine_type == "e2-micro"
    error_message = "Only e2-micro is always-free. e2-small and everything larger is billed."
  }
}

variable "boot_disk_type" {
  description = "Do not change. Standard PD only; the console's default (Balanced) is billed."
  type        = string
  default     = "pd-standard"

  validation {
    condition     = var.boot_disk_type == "pd-standard"
    error_message = <<-EOT
      Always Free covers 30 GB-months of STANDARD persistent disk only.
      pd-balanced and pd-ssd are billed — this is the single most common way
      people end up paying for a "free" VM.
    EOT
  }
}

variable "boot_disk_size_gb" {
  description = "30 GB is the exact free allowance."
  type        = number
  default     = 30

  validation {
    condition     = var.boot_disk_size_gb > 0 && var.boot_disk_size_gb <= 30
    error_message = "The free allowance is 30 GB-months. Above 30 is billed."
  }
}

variable "boot_image" {
  description = "Boot image. Debian 12 ships the gcloud CLI, which the startup script needs."
  type        = string
  default     = "debian-cloud/debian-12"
}

# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------

variable "ssh_source_ranges" {
  description = <<-EOT
    Who may reach port 22. Defaults to Google's IAP TCP-forwarding range only,
    so SSH is never exposed to the internet — connect with:
      gcloud compute ssh scrapyard --tunnel-through-iap
    Add your office CIDR here only if you specifically want direct SSH.
  EOT
  type        = list(string)
  default     = ["35.235.240.0/20"]
}

# ---------------------------------------------------------------------------
# Application config
# ---------------------------------------------------------------------------

variable "git_repo_url" {
  description = "HTTPS clone URL for this repo, e.g. https://github.com/you/scrapyard.git"
  type        = string
}

variable "git_branch" {
  description = "Branch to deploy."
  type        = string
  default     = "main"
}

variable "github_token" {
  description = <<-EOT
    Optional. A PAT with read access, needed only if the repo is private.
    Stored in Secret Manager, never in instance metadata.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

variable "public_hostname" {
  description = "The hostname you'll serve from, e.g. scrapyard.cytactic.com."
  type        = string
}

variable "google_client_id" {
  description = "OAuth client id from the Google Cloud console."
  type        = string
  sensitive   = true
}

variable "google_client_secret" {
  description = "OAuth client secret."
  type        = string
  sensitive   = true
}

variable "tunnel_token" {
  description = "Cloudflare Tunnel token (the string after --token)."
  type        = string
  sensitive   = true
}

variable "allowed_workspace_domains" {
  description = "Comma-separated Workspace domains permitted to sign in."
  type        = string
  default     = "cytactic.com"

  validation {
    condition     = length(trimspace(var.allowed_workspace_domains)) > 0
    error_message = "Must not be empty — the API refuses to boot rather than allow open sign-in."
  }
}

variable "admin_emails" {
  description = "Comma-separated emails granted the admin role."
  type        = string
  default     = ""
}

variable "app_timezone" {
  description = "IANA zone that defines when 'today' flips for the daily board."
  type        = string
  default     = "Asia/Jerusalem"
}

variable "login_background_youtube_id" {
  description = <<-EOT
    Keep the YouTube embed on this tier. Self-hosting a video would consume the
    1 GB/month free egress in roughly 500 page views. Set to "none" to disable.
  EOT
  type        = string
  default     = "xt_1gJkjdec"
}

# ---------------------------------------------------------------------------
# Billing protection
# ---------------------------------------------------------------------------

variable "budget_amount_usd" {
  description = <<-EOT
    Budget in USD. Correct spend for this deployment is $0.00, so $1 is
    deliberately low: any alert means something is misconfigured while it's
    still worth one dollar.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.budget_amount_usd >= 1 && var.budget_amount_usd <= 50
    error_message = "Keep this small. If you need more than $50 you're no longer on the free tier."
  }
}

variable "budget_alert_emails" {
  description = "Emails to notify on budget thresholds. Leave empty to rely on the project's Billing Admins."
  type        = list(string)
  default     = []
}

variable "enable_billing_killswitch" {
  description = <<-EOT
    Deploy the Cloud Function that DETACHES BILLING when the budget is exceeded.

    This is the only thing that actually halts spending — a budget alert is just
    an email. But it is a blunt instrument: detaching billing stops the VM and
    Google eventually deletes the disk. Keep backups. See infra/README.md.
  EOT
  type        = bool
  default     = true
}
