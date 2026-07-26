/**
 * APIs, the VM's service account, and the always-free e2-micro itself.
 */

resource "google_project_service" "services" {
  for_each = toset([
    "compute.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "cloudbilling.googleapis.com",
    "billingbudgets.googleapis.com",
    "pubsub.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])

  service = each.value

  # Leave the APIs enabled on destroy. Disabling them can break other things in
  # the project, and an enabled-but-unused API costs nothing.
  disable_on_destroy = false
}

/**
 * A dedicated service account with two narrow roles.
 *
 * Explicitly NOT the default Compute Engine service account: that one holds
 * project Editor, so anything running on the box could rewrite the whole
 * project. This one can read its own secrets and write logs.
 */
resource "google_service_account" "vm" {
  account_id   = "scrapyard-vm"
  display_name = "Scrapyard VM"
  description  = "Least-privilege identity for the Scrapyard instance."

  depends_on = [google_project_service.services]
}

resource "google_project_iam_member" "vm_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# Lets `gcloud compute ssh --tunnel-through-iap` reach the box without a
# public SSH port.
resource "google_project_service" "iap" {
  service            = "iap.googleapis.com"
  disable_on_destroy = false
}

resource "google_compute_instance" "scrapyard" {
  name         = "scrapyard"
  machine_type = var.machine_type # validated: e2-micro only
  zone         = var.zone
  tags         = ["scrapyard"]

  description = "Scrapyard leaderboard. Always-free tier — see infra/variables.tf."

  boot_disk {
    initialize_params {
      image = var.boot_image
      type  = var.boot_disk_type   # validated: pd-standard only
      size  = var.boot_disk_size_gb # validated: <= 30
    }
  }

  network_interface {
    network    = google_compute_network.scrapyard.id
    subnetwork = google_compute_subnetwork.scrapyard.id

    /**
     * An ephemeral external IP, which is free while attached to a running
     * free-tier instance.
     *
     * It exists purely for OUTBOUND traffic — apt, docker pull, and
     * cloudflared's connection to Cloudflare. Nothing inbound reaches it: the
     * firewall denies everything except IAP-brokered SSH, and the container
     * binds to 127.0.0.1.
     *
     * The alternative (no external IP + Cloud NAT) would cost roughly $32/month,
     * which rather defeats the point.
     */
    access_config {
      network_tier = "STANDARD" # PREMIUM egress is pricier; STANDARD is fine here
    }
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"] # narrowed by IAM roles, not by scopes
  }

  metadata = {
    # OS Login ties SSH access to IAM instead of metadata SSH keys.
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/templates/startup.sh.tftpl", {
    project_id       = var.project_id
    git_repo_url     = var.git_repo_url
    git_branch       = var.git_branch
    uses_github_auth = var.github_token != ""
    public_hostname  = var.public_hostname

    allowed_workspace_domains   = var.allowed_workspace_domains
    admin_emails                = var.admin_emails
    app_timezone                = var.app_timezone
    login_background_youtube_id = var.login_background_youtube_id
  })

  # Standard provisioning; Spot instances are cheaper but get pre-empted, and
  # aren't what the free tier covers.
  scheduling {
    provisioning_model  = "STANDARD"
    preemptible         = false
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  # Keep the disk if the instance is replaced — it holds the database.
  allow_stopping_for_update = true

  depends_on = [
    google_secret_manager_secret_iam_member.vm_access,
    google_project_iam_member.vm_logging,
  ]

  lifecycle {
    # Editing the startup script shouldn't silently rebuild the box and lose the
    # volume. Remove this if you want changes applied by replacement.
    ignore_changes = [metadata_startup_script]
  }
}
