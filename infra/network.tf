/**
 * A purpose-built VPC rather than the `default` network.
 *
 * The default network ships permissive rules — default-allow-ssh from 0.0.0.0/0,
 * plus ICMP and RDP. Building our own means the only ingress that exists is the
 * one declared below.
 *
 * There is no ingress rule for the app itself, on purpose: cloudflared dials
 * OUT to Cloudflare, so nothing ever needs to reach this VM from the internet.
 */

resource "google_compute_network" "scrapyard" {
  name                    = "scrapyard-net"
  auto_create_subnetworks = false
  description             = "Single-subnet network for the Scrapyard VM. No public ingress."

  depends_on = [google_project_service.services]
}

resource "google_compute_subnetwork" "scrapyard" {
  name          = "scrapyard-subnet"
  network       = google_compute_network.scrapyard.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"

  # Logs cost money past the free tier and we have nothing to inspect.
  private_ip_google_access = true
}

/**
 * SSH, restricted to Google's IAP TCP-forwarding range by default.
 *
 * That means port 22 is unreachable from the internet — IAP brokers the
 * connection after checking IAM. Connect with:
 *   gcloud compute ssh scrapyard --zone <zone> --tunnel-through-iap
 */
resource "google_compute_firewall" "ssh_via_iap" {
  name          = "scrapyard-allow-ssh-iap"
  network       = google_compute_network.scrapyard.name
  description   = "SSH from Google's IAP range only. No direct internet exposure."
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = var.ssh_source_ranges
  target_tags   = ["scrapyard"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

/**
 * Explicit catch-all deny, above GCP's implied deny only in that it's visible.
 * Priority 65534 sits just under the implied rule so it documents intent
 * without shadowing anything above it.
 */
resource "google_compute_firewall" "deny_all_ingress" {
  name          = "scrapyard-deny-all-ingress"
  network       = google_compute_network.scrapyard.name
  description   = "Belt and braces: nothing else gets in. The tunnel is outbound-only."
  direction     = "INGRESS"
  priority      = 65534
  source_ranges = ["0.0.0.0/0"]

  deny {
    protocol = "all"
  }
}
