#!/usr/bin/env bash
# Host-side smoke check (#562): every compose service healthy, and each route
# the edge serves answers with the right service. The authenticated user
# journey runs from ops/cloud/remote.sh smoke (it needs the owner password,
# which never lives on this host).
set -euo pipefail
cd "$(dirname "$0")/../../.."
export COMPOSE_PROJECT_NAME=hyperbolic-core COMPOSE_FILE=compose.yaml:compose.cloud.yaml
python3 ops/telemetry.py --project hyperbolic-core >/dev/null
e=http://127.0.0.1:8080
check() { local want="$1" url="$2" got; got="$(curl -fsS -m 10 "$e$url")" || { echo "smoke: $url failed" >&2; return 1; }
  [[ "$got" == *"$want"* ]] || { echo "smoke: $url did not contain $want" >&2; return 1; }; }
check '<div id="root">' /
check '<div id="root">' /life/
check '"ok":true' /platform/health
check '"status":"ok"' /life/api/healthz
check 'ok' /api/brain/health
# The MCP door refuses an unauthenticated call itself (401 + RFC 9728 pointer), even behind Access.
mcp="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST -H 'Host: core.kylegsmith.com' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$e/life/mcp")"
[[ "$mcp" == 401 ]] || { echo "smoke: /life/mcp answered $mcp, want 401" >&2; exit 1; }
echo "smoke: ok (services healthy; shell, life, platform, lifeos, brain, lifeos-mcp routes answer)"
