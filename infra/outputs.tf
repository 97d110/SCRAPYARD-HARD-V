output "instance_name" {
  description = "VM name, for gcloud commands."
  value       = google_compute_instance.scrapyard.name
}

output "zone" {
  value = google_compute_instance.scrapyard.zone
}

output "external_ip" {
  description = "Outbound-only. Nothing inbound reaches it — the firewall denies all but IAP SSH."
  value       = google_compute_instance.scrapyard.network_interface[0].access_config[0].nat_ip
}

output "ssh_command" {
  description = "SSH via IAP, so port 22 is never exposed to the internet."
  value = join(" ", [
    "gcloud compute ssh", google_compute_instance.scrapyard.name,
    "--zone", google_compute_instance.scrapyard.zone,
    "--project", var.project_id,
    "--tunnel-through-iap",
  ])
}

output "bootstrap_log_command" {
  description = "Watch the first boot install Docker, clone and build."
  value       = "sudo journalctl -u google-startup-scripts -f"
}

output "tunnel_public_hostname_target" {
  description = "Enter this as the Public Hostname URL in the Cloudflare tunnel config."
  value       = "api:3000"
}

output "oauth_redirect_uri" {
  description = "Add this to Authorised redirect URIs on your Google OAuth client."
  value       = "https://${var.public_hostname}/api/auth/google/callback"
}

output "killswitch_test_command" {
  description = "Fire the killswitch with a fake over-budget message. Re-attach billing afterwards."
  value = var.enable_billing_killswitch ? join(" ", [
    "gcloud pubsub topics publish", google_pubsub_topic.budget.name,
    "--project", var.project_id,
    "--message='{\"costAmount\":999,\"budgetAmount\":1,\"budgetDisplayName\":\"test\"}'",
  ]) : "killswitch disabled (enable_billing_killswitch = false)"
}

output "free_tier_summary" {
  description = "What was provisioned, and why each value keeps it free."
  value = {
    machine_type   = "${var.machine_type} — the only always-free machine type"
    region         = "${var.region} — one of the three always-free regions"
    boot_disk      = "${var.boot_disk_size_gb}GB ${var.boot_disk_type} — Balanced/SSD would be billed"
    external_ip    = "ephemeral, free while attached to a running free-tier instance"
    egress_limit   = "1 GB/month from North America — this app uses roughly 50-100 MB"
    secret_manager = "${length(local.secrets)} secrets of the 6 always-free versions"
    expected_cost  = "$0.00/month"
  }
}
