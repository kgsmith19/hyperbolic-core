#!/usr/bin/env bash
# Hyperbolic Core Cloudflare operator (#562). The only supported way to change
# core.kylegsmith.com's Cloudflare configuration.
#
#   infra/cloudflare/cf.sh preflight       token + read checks, owner-only policy check
#   infra/cloudflare/cf.sh plan            preflight, then a plan that must not destroy
#   infra/cloudflare/cf.sh apply           plan, refuse destroys, apply that exact plan
#   infra/cloudflare/cf.sh publish-secrets copy tunnel + ops service token into Infisical
#   infra/cloudflare/cf.sh verify          live checks: tunnel healthy, Access gate, DNS
#
# Credentials come from Infisical (project hyperbolic-core, env prod) through a
# machine identity: INFISICAL_TOKEN, or INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET
# (universal auth), plus INFISICAL_PROJECT_ID. Nothing secret is printed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

CF_API="https://api.cloudflare.com/client/v4"
ACCOUNT_ID="$(sed -n '/variable "account_id"/,/}/s/.*default *= *"\(.*\)"/\1/p' variables.tf)"
ZONE_ID="$(sed -n '/variable "zone_id"/,/}/s/.*default *= *"\(.*\)"/\1/p' variables.tf)"
CORE_HOST="core.kylegsmith.com"


# Infisical login and secret_get/secret_put (stdin/stdout only) are shared
# with the host tooling.
. "$here/../../ops/cloud/lib.sh"

load_credentials() {
  CLOUDFLARE_API_TOKEN="$(secret_get / CLOUDFLARE_API_TOKEN)"; export CLOUDFLARE_API_TOKEN
  TF_VAR_owner_email="$(secret_get /platform/core OWNER_EMAIL)"; export TF_VAR_owner_email
  TF_VAR_state_passphrase="$(secret_get /platform/cloudflare TF_STATE_PASSPHRASE)"; export TF_VAR_state_passphrase
}

cf_get() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$CF_API$1"; }

preflight() {
  load_credentials
  command -v tofu >/dev/null || die "OpenTofu (tofu) is required"
  cf_get /user/tokens/verify | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];assert r["status"]=="active",r' ||
    die "Cloudflare token is not active"
  # Each read the configuration needs: account, zone, DNS, Access, tunnels.
  for path in "/accounts/$ACCOUNT_ID" "/zones/$ZONE_ID" "/zones/$ZONE_ID/dns_records?per_page=1" \
              "/accounts/$ACCOUNT_ID/access/apps" "/accounts/$ACCOUNT_ID/access/policies" \
              "/accounts/$ACCOUNT_ID/cfd_tunnel?per_page=1"; do
    cf_get "$path" >/dev/null || die "token cannot read $path"
  done
  # Owner Only must allow exactly the owner's email, with nothing broader.
  cf_get "/accounts/$ACCOUNT_ID/access/policies" | OWNER="$TF_VAR_owner_email" python3 -c '
import json, os, sys
pol = [p for p in json.load(sys.stdin)["result"] if p["name"] == "Owner Only"]
assert len(pol) == 1, "expected exactly one Owner Only policy"
p = pol[0]
assert p["decision"] == "allow", p["decision"]
assert p["include"] == [{"email": {"email": os.environ["OWNER"]}}], "Owner Only include is not exactly the owner email"
assert not p.get("exclude") and not p.get("require"), "unexpected exclude/require rules"
' || die "Owner Only policy drifted from the single owner email"
  log "preflight ok (token active, reads ok, Owner Only = owner email only)"
}

# Writers are serialised: refuse to touch state that is behind origin.
guard_state_fresh() {
  git fetch -q origin main 2>/dev/null || return 0
  if ! git diff --quiet origin/main -- state/ 2>/dev/null && [[ "${CF_ALLOW_LOCAL_STATE:-}" != 1 ]]; then
    die "state/ differs from origin/main: merge or rebase first (or CF_ALLOW_LOCAL_STATE=1 for the open PR)"
  fi
  exec 9>"$here/.cf.lock"; flock -n 9 || die "another cf.sh run holds the lock"
}

plan() {
  preflight
  guard_state_fresh
  tofu init -input=false >/dev/null
  tofu plan -input=false -out=cf.tfplan >/dev/null
  tofu show -json cf.tfplan | python3 -c '
import json, sys
plan = json.load(sys.stdin)
changes = [(rc["address"], rc["change"]["actions"]) for rc in plan.get("resource_changes", [])
           if rc["change"]["actions"] not in (["no-op"], ["read"])]
bad = [c for c in changes if "delete" in c[1]]
for addr, actions in changes: print("  %14s  %s" % ("+".join(actions), addr), file=sys.stderr)
if not changes: print("cf.sh: No changes. Cloudflare matches the configuration.", file=sys.stderr)
if bad: sys.exit("cf.sh: REFUSING: the plan destroys or replaces resources: %s" % bad)
'
}

apply() {
  plan
  tofu apply -input=false cf.tfplan
  rm -f cf.tfplan
  log "applied; commit infra/cloudflare/state/ (encrypted) with the change"
}

publish_secrets() {
  set -o pipefail
  load_credentials
  tofu init -input=false >/dev/null
  tofu output -raw tunnel_token | secret_put /platform/core-tunnel TUNNEL_TOKEN
  tofu output -raw ops_service_token_client_id | secret_put /platform/core OPS_ACCESS_CLIENT_ID
  tofu output -raw ops_service_token_client_secret | secret_put /platform/core OPS_ACCESS_CLIENT_SECRET
}

verify() {
  load_credentials
  local tunnel_id fail=0
  tunnel_id="$(cf_get "/accounts/$ACCOUNT_ID/cfd_tunnel?name=hyperbolic-core-prod&is_deleted=false" |
    python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r[0]["id"] if r else "")')"
  [[ -n "$tunnel_id" ]] || die "tunnel hyperbolic-core-prod not found"
  status="$(cf_get "/accounts/$ACCOUNT_ID/cfd_tunnel/$tunnel_id" | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];print(r["status"], len(r.get("connections") or []))')"
  echo "tunnel hyperbolic-core-prod: $status (status, connections)"
  [[ "$status" == healthy* ]] || fail=1
  # Unauthenticated browsers must be sent to Access, never to the origin.
  code_loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "https://$CORE_HOST/")"
  echo "unauthenticated GET https://$CORE_HOST/ -> ${code_loc%%\?*}"
  [[ "$code_loc" == 302\ https://*.cloudflareaccess.com/* ]] || fail=1
  # A forged Access cookie must not get through either.
  forged="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Cookie: CF_Authorization=forged.jwt.value' "https://$CORE_HOST/")"
  echo "forged CF_Authorization cookie -> $forged"
  [[ "$forged" == 302 || "$forged" == 403 ]] || fail=1
  # Only the managed hostnames point at the tunnel; apex and www are untouched.
  cf_get "/zones/$ZONE_ID/dns_records?per_page=100" | python3 -c '
import json, sys
recs = json.load(sys.stdin)["result"]
for r in recs: print("dns %-6s %-28s proxied=%s" % (r["type"], r["name"], r["proxied"]))
tun = {r["name"] for r in recs if r["content"].endswith(".cfargotunnel.com")}
assert tun <= {"core.kylegsmith.com", "ssh-core.kylegsmith.com"}, tun
assert not any(r["name"] in ("kylegsmith.com", "www.kylegsmith.com") and r["content"].endswith(".cfargotunnel.com") for r in recs)
' || fail=1
  ((fail == 0)) && log "verify ok" || die "verify FAILED"
}

case "${1:-}" in
  preflight) preflight ;;
  plan) plan ;;
  apply) apply ;;
  publish-secrets) publish_secrets ;;
  verify) verify ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
