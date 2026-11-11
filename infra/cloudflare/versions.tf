terraform {
  required_version = ">= 1.10.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

# State lives encrypted in-repo (state/terraform.tfstate): R2 is not enabled on
# the account, and every resource here is importable, so Git history is the
# backup and the passphrase lives only in Infisical
# (prod:/platform/cloudflare/TF_STATE_PASSPHRASE). cf.sh serialises writers with
# a lock commit check; see docs/ops/cloudflare-agent-access.md.
terraform {
  backend "local" {
    path = "state/terraform.tfstate"
  }

  encryption {
    key_provider "pbkdf2" "main" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "main" {
      keys = key_provider.pbkdf2.main
    }
    state {
      method   = method.aes_gcm.main
      enforced = true
    }
    plan {
      method   = method.aes_gcm.main
      enforced = true
    }
  }
}
