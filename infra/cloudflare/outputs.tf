output "tunnel_id" {
  value = cloudflare_zero_trust_tunnel_cloudflared.prod.id
}

output "core_aud" {
  value = cloudflare_zero_trust_access_application.core.aud
}

output "ops_aud" {
  value = cloudflare_zero_trust_access_application.ops.aud
}

output "ops_service_token_client_id" {
  value = cloudflare_zero_trust_access_service_token.ops.client_id
}

output "ops_service_token_client_secret" {
  value     = cloudflare_zero_trust_access_service_token.ops.client_secret
  sensitive = true
}

output "tunnel_token" {
  value     = data.cloudflare_zero_trust_tunnel_cloudflared_token.prod.token
  sensitive = true
}
