# Non-secret identifiers. owner_email comes from Infisical (TF_VAR_owner_email,
# set by cf.sh) so the approved identity is never written into Git.
variable "account_id" {
  type    = string
  default = "3bf4b2ef46e5fccc29a0abe48b9b6f01"
}

variable "zone_id" {
  type    = string
  default = "6bea90905c29e718da7df2f169bd21c7"
}

variable "zone_name" {
  type    = string
  default = "kylegsmith.com"
}

variable "access_team_name" {
  type    = string
  default = "spring-smoke-421e"
}

variable "core_app_id" {
  type    = string
  default = "1c4238bb-fbb8-4e37-88ae-697485b769df"
}

variable "owner_policy_id" {
  type    = string
  default = "e0dc6d66-84ab-4da3-98ae-e6f671970d40"
}

variable "owner_email" {
  type      = string
  sensitive = true
}

variable "state_passphrase" {
  type      = string
  sensitive = true
}

variable "mcp_oauth_redirect_uris" {
  description = "OAuth redirect URIs allowed for dynamically registered MCP clients (one per harness)."
  type        = list(string)
  default = [
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
  ]
}
