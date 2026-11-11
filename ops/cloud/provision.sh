#!/usr/bin/env bash
# Create hyperbolic-core-prod on Hetzner Cloud (#562). Idempotent: an existing
# server, firewall or key is reused, never replaced. Operator-side; needs the
# Infisical machine identity (see docs/ops/cloud-deploy.md).
#
#   ops/cloud/provision.sh            create firewall, SSH key, server (cx33)
#
# Cost: CX33 + 20% provider backups (≈ US$12/month in 2026-11). Approved by
# the owner on #562; any other server type needs a new approval.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

NAME=hyperbolic-core-prod TYPE="${HCLOUD_TYPE:-cx33}" LOCATION="${HCLOUD_LOCATION:-nbg1}" IMAGE=ubuntu-24.04
LABELS='{"platform":"hyperbolic-core","env":"prod","managed-by":"ops-cloud-provision"}'
HCLOUD_TOKEN="$(secret_get /providers/hetzner HETZNER_API_TOKEN)"
hc() { local m="$1" p="$2"; shift 2; curl -fsS -X "$m" -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' "https://api.hetzner.cloud/v1$p" "$@"; }
id_of() { python3 -c "import sys,json;r=json.load(sys.stdin)['$1'];print(r[0]['id'] if r else '')"; }

# Firewall with NO inbound rules: the host is reached only through the tunnel.
fw="$(hc GET "/firewalls?name=$NAME-fw" | id_of firewalls)"
if [[ -z "$fw" ]]; then
  fw="$(hc POST /firewalls -d "{\"name\":\"$NAME-fw\",\"labels\":$LABELS,\"rules\":[]}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["firewall"]["id"])')"
  log "created firewall $NAME-fw (no inbound rules)"
fi

# Deploy SSH key: generated once, private half kept only in Infisical.
pub="$(secret_get /platform/core DEPLOY_SSH_PUBLIC_KEY 2>/dev/null || true)"
if [[ -z "$pub" ]]; then
  tmp="$(mktemp -d)"; ssh-keygen -q -t ed25519 -N '' -C "deploy@$NAME" -f "$tmp/k"
  secret_put /platform/core DEPLOY_SSH_PRIVATE_KEY < "$tmp/k"
  secret_put /platform/core DEPLOY_SSH_PUBLIC_KEY < "$tmp/k.pub"
  pub="$(cat "$tmp/k.pub")"; rm -rf "$tmp"
fi
key="$(hc GET "/ssh_keys?name=$NAME-deploy" | id_of ssh_keys)"
[[ -n "$key" ]] || key="$(hc POST /ssh_keys -d "$(python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1]+"-deploy","public_key":sys.argv[2],"labels":json.loads(sys.argv[3])}))' "$NAME" "$pub" "$LABELS")" | python3 -c 'import sys,json;print(json.load(sys.stdin)["ssh_key"]["id"])')"

srv="$(hc GET "/servers?name=$NAME" | id_of servers)"
if [[ -n "$srv" ]]; then log "server $NAME already exists ($srv); nothing to create"; exit 0; fi

tunnel_token="$(secret_get /platform/core-tunnel TUNNEL_TOKEN)"
user_data="$(python3 - "$here/cloud-init.yaml" "$pub" "$tunnel_token" <<'PY'
import sys
text = open(sys.argv[1]).read()
print(text.replace("__DEPLOY_PUBKEY__", sys.argv[2].strip()).replace("__TUNNEL_TOKEN__", sys.argv[3].strip()), end="")
PY
)"
body="$(python3 -c '
import json,sys
print(json.dumps({"name":sys.argv[1],"server_type":sys.argv[2],"location":sys.argv[3],"image":sys.argv[4],
  "ssh_keys":[int(sys.argv[5])],"firewalls":[{"firewall":int(sys.argv[6])}],"labels":json.loads(sys.argv[7]),
  "user_data":sys.stdin.read(),"public_net":{"enable_ipv4":True,"enable_ipv6":True},"start_after_create":True}))' \
  "$NAME" "$TYPE" "$LOCATION" "$IMAGE" "$key" "$fw" "$LABELS" <<<"$user_data")"
srv="$(hc POST /servers -d "$body" | python3 -c 'import sys,json;print(json.load(sys.stdin)["server"]["id"])')"
log "created server $NAME ($srv, $TYPE, $LOCATION)"
sleep 20
hc POST "/servers/$srv/actions/enable_backup" >/dev/null && log "provider backups enabled"
hc POST "/servers/$srv/actions/change_protection" -d '{"delete":true,"rebuild":true}' >/dev/null && log "delete/rebuild protection on"
