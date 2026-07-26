/**
 * Billing protection, in three layers.
 *
 *   1. variables.tf validation — you can't provision a billable shape
 *   2. the budget below        — tells you (email only; it does NOT stop spend)
 *   3. the killswitch function — the only thing that actually halts spend
 *
 * Google's own documentation is explicit that budgets "don't automatically
 * prevent the use or billing of your services when the budget amount or
 * threshold rules are met or exceeded". Layer 3 exists because of that sentence.
 */

# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_billing_budget" "scrapyard" {
  billing_account = var.billing_account
  display_name    = "scrapyard-hard-cap"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]

    /**
     * EXCLUDE_ALL_CREDITS is the important choice here.
     *
     * With credits included, the $300 trial credit is subtracted from cost, so
     * the budget reports ~$0 and never fires even while you're burning credits
     * on something misconfigured. Excluding them means the budget sees gross
     * spend and complains immediately — which is what we want, because correct
     * spend for this deployment is $0.00.
     */
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }

  # Warn early, act at 100%.
  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.9
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

  all_updates_rule {
    # Where the killswitch listens.
    pubsub_topic   = google_pubsub_topic.budget.id
    schema_version = "1.0"

    monitoring_notification_channels = [
      for c in google_monitoring_notification_channel.budget_email : c.id
    ]

    # Also email the billing admins, so a broken function isn't silent.
    disable_default_iam_recipients = false
  }

  depends_on = [google_project_service.services]
}

resource "google_monitoring_notification_channel" "budget_email" {
  for_each = toset(var.budget_alert_emails)

  display_name = "Scrapyard budget — ${each.value}"
  type         = "email"

  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.services]
}

resource "google_pubsub_topic" "budget" {
  name = "scrapyard-budget-notifications"

  depends_on = [google_project_service.services]
}

# ---------------------------------------------------------------------------
# Killswitch function
# ---------------------------------------------------------------------------

resource "google_project_service" "functions" {
  for_each = var.enable_billing_killswitch ? toset([
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "eventarc.googleapis.com",
    "artifactregistry.googleapis.com",
    "storage.googleapis.com",
    "monitoring.googleapis.com",
  ]) : toset([])

  service            = each.value
  disable_on_destroy = false
}

data "archive_file" "killswitch" {
  count = var.enable_billing_killswitch ? 1 : 0

  type        = "zip"
  source_dir  = "${path.module}/killswitch"
  output_path = "${path.module}/.build/killswitch.zip"
}

resource "google_storage_bucket" "functions" {
  count = var.enable_billing_killswitch ? 1 : 0

  name                        = "${var.project_id}-scrapyard-functions"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  force_destroy               = true

  # Keep the bucket tiny — old source archives serve no purpose.
  lifecycle_rule {
    condition {
      num_newer_versions = 2
    }
    action {
      type = "Delete"
    }
  }

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.functions]
}

resource "google_storage_bucket_object" "killswitch" {
  count = var.enable_billing_killswitch ? 1 : 0

  # Hash in the name so a source change triggers a redeploy.
  name   = "killswitch-${data.archive_file.killswitch[0].output_md5}.zip"
  bucket = google_storage_bucket.functions[0].name
  source = data.archive_file.killswitch[0].output_path
}

resource "google_service_account" "killswitch" {
  count = var.enable_billing_killswitch ? 1 : 0

  account_id   = "scrapyard-killswitch"
  display_name = "Scrapyard billing killswitch"
  description  = "Detaches billing from the project when the budget is exceeded."

  depends_on = [google_project_service.services]
}

/**
 * The one permission that makes this work — and the reason it's on a dedicated
 * service account rather than the default one.
 *
 * roles/billing.admin on the BILLING ACCOUNT (not the project) is what allows
 * `updateProjectBillingInfo` to detach. It is a powerful grant; scoping it to a
 * service account whose only code is 60 lines of killswitch keeps the blast
 * radius small.
 */
resource "google_billing_account_iam_member" "killswitch" {
  count = var.enable_billing_killswitch ? 1 : 0

  billing_account_id = var.billing_account
  role               = "roles/billing.admin"
  member             = "serviceAccount:${google_service_account.killswitch[0].email}"
}

resource "google_cloudfunctions2_function" "killswitch" {
  count = var.enable_billing_killswitch ? 1 : 0

  name        = "scrapyard-billing-killswitch"
  location    = var.region
  description = "Detaches billing when the budget is exceeded. Destructive — see infra/README.md."

  build_config {
    runtime     = "nodejs20"
    entry_point = "stopBilling"

    source {
      storage_source {
        bucket = google_storage_bucket.functions[0].name
        object = google_storage_bucket_object.killswitch[0].name
      }
    }
  }

  service_config {
    # One instance is plenty and prevents a notification storm from fanning out.
    max_instance_count = 1
    min_instance_count = 0
    available_memory   = "256Mi"
    timeout_seconds    = 60

    environment_variables = {
      TARGET_PROJECT_ID = var.project_id
    }

    service_account_email = google_service_account.killswitch[0].email
  }

  event_trigger {
    trigger_region = var.region
    event_type     = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic   = google_pubsub_topic.budget.id
    retry_policy   = "RETRY_POLICY_RETRY"
  }

  depends_on = [
    google_project_service.functions,
    google_billing_account_iam_member.killswitch,
  ]
}
