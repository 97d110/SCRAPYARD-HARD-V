terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.14"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state in GCS: versioned, encrypted at rest, and locked so two
  # applies can't race.
  #
  # This matters here because the state contains your Google client secret, JWT
  # secret and tunnel token in plaintext. Never commit it.
  #
  # Chicken-and-egg: the bucket must exist before this block can be used. Create
  # it once with the gcloud command in README.md, then run `tofu init`.
  backend "gcs" {
    # Set via `tofu init -backend-config=backend.hcl` — see backend.hcl.example.
    # Hardcoding the bucket name here would make this file account-specific.
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
