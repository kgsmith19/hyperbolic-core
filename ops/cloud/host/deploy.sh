#!/usr/bin/env bash
# hyperbolic-core-prod release step (#562). Runs ON the host as `deploy`.
#
#   git archive <sha> | deploy.sh <sha>     unpack, back up, build, start, smoke
#   deploy.sh --rollback                    make the previous release live again
#
# Layout (all under /srv/hyperbolic-core, created by cloud-init):
#   releases/<sha>/   one unpacked tree per release; `current` -> the live one
#   var/              persistent state (HYP_VAR); every release's var/ links here
#   env/              runtime env files (0600), linked into each release
#   backups/          pre-deploy and nightly store_ops.py backups
# A failed health/smoke check after `up` restarts the previous release.
set -euo pipefail

BASE=/srv/hyperbolic-core
export HYP_VAR="$BASE/var" COMPOSE_PROJECT_NAME=hyperbolic-core
export COMPOSE_FILE=compose.yaml:compose.cloud.yaml
export HOST_UID HOST_GID; HOST_UID="$(id -u)"; HOST_GID="$(id -g)"
log() { echo "deploy: $*" >&2; }

link_shared() {  # <release dir>
  local r="$1"
  ln -sfn "$BASE/var" "$r/var"
  ln -sfn "$BASE/env/platform-api.env" "$r/services/platform-api/.env"
  ln -sfn "$BASE/env/lifeos.env" "$r/apps/lifeos/backend/.env"
  ln -sfn "$BASE/env/brain.env" "$r/services/brain/.env"
}

start() {  # <release dir>
  local r="$1"
  cd "$r"
  set -a; . "$BASE/env/build.env"; set +a   # PLATFORM_ANON_KEY (public), PUBLIC_ORIGIN
  mkdir -p "$HYP_VAR"/{platform,network-checker,lifeos/blobs,brain/home,brain-workspaces,broker}
  # The broker's deny-by-default policy, generated from every tool.json.
  docker run --rm -u "$HOST_UID:$HOST_GID" -v "$r:/w:ro" -v "$HYP_VAR/broker:/out" -w /w node:22-slim \
    node packages/manifest-tools/generate-broker-policy.mjs --out /out/broker-policy.json >/dev/null
  docker compose build --pull
  docker compose up -d --wait --wait-timeout 300 --remove-orphans
  "$r/ops/cloud/host/smoke.sh"
}

restore() {  # <release dir>: make it live again
  local target="$1"
  [[ -n "$target" && -d "$target" ]] || { log "no release to restore"; return 1; }
  log "restoring $(basename "$target")"
  start "$target"
  ln -sfn "$target" "$BASE/current"
  echo "$(date -u +%FT%TZ) restore $(basename "$target")" >> "$BASE/releases.log"
}

if [[ "${1:-}" == "--rollback" ]]; then
  # Operator rollback: previous becomes live, and the release it replaces
  # becomes `previous`, so a second --rollback undoes the first.
  prev="$(readlink -f "$BASE/previous" 2>/dev/null || true)"
  cur="$(readlink -f "$BASE/current" 2>/dev/null || true)"
  restore "$prev"
  [[ -n "$cur" ]] && ln -sfn "$cur" "$BASE/previous"
  exit
fi

sha="${1:?usage: git archive <sha> | deploy.sh <sha>}"
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || { log "not a commit sha: $sha"; exit 2; }
rel="$BASE/releases/$sha"
rm -rf "$rel.tmp" && mkdir -p "$rel.tmp" && tar -x -C "$rel.tmp" && rm -rf "$rel" && mv "$rel.tmp" "$rel"
echo "$sha" > "$rel/.release-sha"
link_shared "$rel"

# Consistent pre-deploy backup of every SQLite store (online backup API).
if [[ -e "$BASE/current" ]]; then
  (cd "$(readlink -f "$BASE/current")" && python3 ops/store_ops.py backup "$BASE/backups/predeploy-$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null)
  log "pre-deploy backup written"
fi

if start "$rel"; then
  cur="$(readlink -f "$BASE/current" 2>/dev/null || true)"
  if [[ -n "$cur" && "$cur" != "$rel" ]]; then ln -sfn "$cur" "$BASE/previous"; fi
  ln -sfn "$rel" "$BASE/current"
  echo "$(date -u +%FT%TZ) deploy $sha ok" >> "$BASE/releases.log"
  # Keep the five newest releases.
  ls -1dt "$BASE"/releases/*/ | tail -n +6 | while read -r old; do
    [[ "$(readlink -f "$old")" == "$(readlink -f "$BASE/current")" ]] || rm -rf "$old"
  done
  log "release $sha is live"
else
  echo "$(date -u +%FT%TZ) deploy $sha FAILED" >> "$BASE/releases.log"
  log "release $sha failed its checks"
  # `current` still names the last good release: bring it back.
  cur="$(readlink -f "$BASE/current" 2>/dev/null || true)"
  if [[ -n "$cur" && "$cur" != "$rel" ]]; then restore "$cur"; fi
  exit 1
fi
