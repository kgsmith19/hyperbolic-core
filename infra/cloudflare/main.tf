# Hyperbolic Core — Cloudflare edge for core.kylegsmith.com (#562).
#
# Browser -> Cloudflare Access ("Hyperbolic Core", Owner Only) -> Tunnel
# "hyperbolic-core-prod" -> 127.0.0.1:8080 (edge/Caddy) on hyperbolic-core-prod.
#
# Only the hostnames below are managed. The apex and www stay untouched and
# are reserved for a future public site. Run through ./cf.sh, never bare tofu:
# it pulls credentials from Infisical, refuses any plan that destroys, and
# keeps state encrypted (see docs/ops/cloudflare-agent-access.md).

provider "cloudflare" {}

locals {
  core_host = "core.${var.zone_name}"
  ops_host  = "ssh-core.${var.zone_name}"
}

# --- Existing resources, imported (created by the owner in the dashboard) ---

import {
  to = cloudflare_zero_trust_access_application.core
  id = "accounts/${var.account_id}/${var.core_app_id}"
}

import {
  to = cloudflare_zero_trust_access_policy.owner_only
  id = "${var.account_id}/${var.owner_policy_id}"
}

resource "cloudflare_zero_trust_access_policy" "owner_only" {
  account_id = var.account_id
  name       = "Owner Only"
  decision   = "allow"
  include    = [{ email = { email = var.owner_email } }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "core" {
  account_id                = var.account_id
  name                      = "Hyperbolic Core"
  type                      = "self_hosted"
  domain                    = local.core_host
  destinations              = [{ type = "public", uri = local.core_host }]
  session_duration          = "24h"
  app_launcher_visible      = true
  auto_redirect_to_identity = false
  policies                  = [{ id = cloudflare_zero_trust_access_policy.owner_only.id, precedence = 1 }]

  lifecycle {
    prevent_destroy = true
  }
}

# --- Agent ingress: remote MCP for any harness, OAuth by Access (hyperbolic-core #633) ---
# Path-scoped, so Access OAuth covers only /life/mcp; the rest of core keeps browser SSO only.
# Access is the OAuth authorization server (Managed OAuth, beta): MCP clients discover it at
# https://core.kylegsmith.com/.well-known/oauth-authorization-server, the owner signs in once
# per harness, and the origin verifies the forwarded Access JWT (apps/lifeos/docs/agent-ingress.md).
resource "cloudflare_zero_trust_access_application" "mcp" {
  account_id                = var.account_id
  name                      = "LifeOS MCP"
  type                      = "self_hosted"
  domain                    = "${local.core_host}/life/mcp"
  destinations              = [{ type = "public", uri = "${local.core_host}/life/mcp" }]
  session_duration          = "24h"
  app_launcher_visible      = false
  auto_redirect_to_identity = false
  policies                  = [{ id = cloudflare_zero_trust_access_policy.owner_only.id, precedence = 1 }]
  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_localhost = false
      allow_any_on_loopback  = false
      # Only the hosted harnesses' callbacks; add one line per new harness.
      allowed_uris = var.mcp_oauth_redirect_uris
    }
    grant = {
      access_token_lifetime = "15m"
      session_duration      = "720h"
    }
  }
}

# --- Operator channel: SSH to the host through the tunnel, no inbound ports ---

resource "cloudflare_zero_trust_access_service_token" "ops" {
  account_id = var.account_id
  name       = "hyperbolic-core-ops"
  duration   = "8760h"
}

resource "cloudflare_zero_trust_access_policy" "ops_service_token" {
  account_id = var.account_id
  name       = "Hyperbolic Core Ops Service Token"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.ops.id } }]
}

resource "cloudflare_zero_trust_access_application" "ops" {
  account_id                = var.account_id
  name                      = "Hyperbolic Core Ops"
  type                      = "self_hosted"
  domain                    = local.ops_host
  destinations              = [{ type = "public", uri = local.ops_host }]
  session_duration          = "1h"
  app_launcher_visible      = false
  auto_redirect_to_identity = false
  policies = [
    { id = cloudflare_zero_trust_access_policy.ops_service_token.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.owner_only.id, precedence = 2 },
  ]
}

# --- Tunnel ---

resource "cloudflare_zero_trust_tunnel_cloudflared" "prod" {
  account_id = var.account_id
  name       = "hyperbolic-core-prod"
  config_src = "cloudflare"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "prod" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.prod.id
  config = {
    ingress = [
      {
        hostname = local.core_host
        service  = "http://127.0.0.1:8080"
        origin_request = {
          # cloudflared itself rejects any request without a valid Access JWT
          # for this application, so a route around Access cannot reach Caddy.
          access = {
            required  = true
            team_name = var.access_team_name
            # The MCP path app has its own AUD; both are valid for this hostname.
            aud_tag = [
              cloudflare_zero_trust_access_application.core.aud,
              cloudflare_zero_trust_access_application.mcp.aud,
            ]
          }
        }
      },
      {
        hostname = local.ops_host
        service  = "ssh://127.0.0.1:22"
        origin_request = {
          access = {
            required  = true
            team_name = var.access_team_name
            aud_tag   = [cloudflare_zero_trust_access_application.ops.aud]
          }
        }
      },
      { service = "http_status:404" },
    ]
  }
}

resource "cloudflare_dns_record" "core" {
  zone_id = var.zone_id
  name    = local.core_host
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.prod.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "hyperbolic-core: tunnel hyperbolic-core-prod (managed by infra/cloudflare)"
}

resource "cloudflare_dns_record" "ops" {
  zone_id = var.zone_id
  name    = local.ops_host
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.prod.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "hyperbolic-core: operator SSH via tunnel (managed by infra/cloudflare)"
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "prod" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.prod.id
}

# --- Login methods ---
# Email one-time PIN: the owner signs in with their email and a 6-digit code
# (docs/ops/login.md). The Owner Only policy still decides who may enter;
# the PIN only proves control of the address. The existing "Cloudflare"
# account login stays available alongside it.
resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  account_id = var.account_id
  name       = "One-time PIN"
  type       = "onetimepin"
  config     = {}
}
