#!/usr/bin/env bash
# Local canary (#504, canary-missing): build and start the candidate as a
# separate compose project on shifted loopback ports, require every service
# healthy (ops/telemetry.py), then tear the canary down with its volumes.
# The live stack is never touched. Exit 0 only when the canary was healthy.
set -euo pipefail
cd "$(dirname "$0")/.."
project="${CANARY_PROJECT:-hyp-canary}"
offset="${CANARY_PORT_OFFSET:-10000}"
for var in PLATFORM_API_PORT:8400 NETWORK_CHECKER_PORT:8787 LIFEOS_PORT:8000 LIFEOS_MCP_PORT:8090 BROKER_PORT:8300 BRAIN_PORT:8100; do
  name="${var%%:*}"; base="${var##*:}"
  export "HOST_${name}=$((base + offset))"
done
# The canary gets its own state root, so it never reads or writes live data.
HYP_VAR="$(mktemp -d)"
export HYP_VAR HOST_UID="${HOST_UID:-$(id -u)}" HOST_GID="${HOST_GID:-$(id -g)}"
mkdir -p "$HYP_VAR"/{platform,network-checker,lifeos/blobs,brain/home,brain-workspaces,broker}
cp var/broker/broker-policy.json "$HYP_VAR/broker/" 2>/dev/null || true
cleanup() {
  docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$HYP_VAR"
}
trap cleanup EXIT
docker compose -p "$project" up -d --build --wait
python3 ops/telemetry.py --project "$project" >/dev/null
echo "canary $project healthy"
