/**
 * Secrets live in Secret Manager, not in instance metadata.
 *
 * That distinction matters: a startup script is readable by anyone with
 * `compute.instances.get` on the project. Putting the Google client secret and
 * JWT secret there would leak them to every project viewer. Instead the script
 * fetches them at boot using the VM's own service account.
 *
 * Cost: Secret Manager's always-free tier covers 6 active secret versions and
 * 10,000 access operations per month. We use 4 (5 with a GitHub token) and read
 * them once per boot, so this is free.
 *
 * Note on versions: `deletion_policy = "DELETE"` means updating a value here
 * destroys the previous version rather than leaving it active. Without that,
 * a few `tofu apply` runs would quietly push you past the 6-version allowance.
 */

# Generated once and kept in state, so re-applying doesn't invalidate everyone's
# session. Replace with a variable if you'd rather manage it yourself.
resource "random_password" "jwt_secret" {
  length  = 64
  special = false
}

locals {
  jwt_secret = random_password.jwt_secret.result

  secrets = merge(
    {
      "scrapyard-google-client-id"     = var.google_client_id
      "scrapyard-google-client-secret" = var.google_client_secret
      "scrapyard-jwt-secret"           = local.jwt_secret
      "scrapyard-tunnel-token"         = var.tunnel_token
    },
    var.github_token == "" ? {} : {
      "scrapyard-github-token" = var.github_token
    }
  )
}

resource "google_secret_manager_secret" "app" {
  for_each  = local.secrets
  secret_id = each.key

  replication {
    # Single region keeps it inside the free tier and near the VM.
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  labels = {
    app = "scrapyard"
  }

  depends_on = [google_project_service.services]
}

resource "google_secret_manager_secret_version" "app" {
  for_each = local.secrets

  secret      = google_secret_manager_secret.app[each.key].id
  secret_data = each.value

  # Destroy superseded versions so we stay under the 6-version free allowance.
  deletion_policy = "DELETE"
}

# The VM's service account may read these secrets and nothing else.
resource "google_secret_manager_secret_iam_member" "vm_access" {
  for_each = local.secrets

  secret_id = google_secret_manager_secret.app[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}
