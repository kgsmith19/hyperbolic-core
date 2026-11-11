#!/usr/bin/env bash
# Operator access to hyperbolic-core-prod (#562). The host has no inbound
# ports: SSH rides the Cloudflare Tunnel (ssh-core.kylegsmith.com), gated by
# the Access app "Hyperbolic Core Ops" (service token or the owner).
#
#   ops/cloud/remote.sh ssh [command...]   run a command on the host as deploy
#   ops/cloud/remote.sh deploy [ref]       ship <ref> (default HEAD), env, deploy.sh
#   ops/cloud/remote.sh rollback           make the previous release live again
#   ops/cloud/remote.sh smoke              authenticated user journey via the edge
#   ops/cloud/remote.sh backup             run the nightly backup now
#
# Needs: cloudflared, ssh, git, and an Infisical machine identity
# (INFISICAL_PROJECT_ID plus INFISICAL_TOKEN or INFISICAL_CLIENT_ID/SECRET).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
. "$here/lib.sh"

HOST=ssh-core.kylegsmith.com
BASE=/srv/hyperbolic-core
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
umask 077
mkdir -p "$HOME/.ssh"
secret_get /platform/core DEPLOY_SSH_PRIVATE_KEY > "$work/key"
TUNNEL_SERVICE_TOKEN_ID="$(secret_get /platform/core OPS_ACCESS_CLIENT_ID)"
TUNNEL_SERVICE_TOKEN_SECRET="$(secret_get /platform/core OPS_ACCESS_CLIENT_SECRET)"
export TUNNEL_SERVICE_TOKEN_ID TUNNEL_SERVICE_TOKEN_SECRET   # read by cloudflared
SSH=(ssh -i "$work/key" -o IdentitiesOnly=yes -o BatchMode=yes -o ServerAliveInterval=30
     -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts_hyperbolic_core"
     -o "ProxyCommand=cloudflared access ssh --hostname %h" "deploy@$HOST")
on_host() { "${SSH[@]}" "$@"; }

# Writes the runtime env files on the host if they are missing (first deploy)
# and refreshes the ones derived from Infisical. Secrets travel on stdin.
put_file() {  # <remote path> (content on stdin)
  on_host "umask 077; cat > '$1.tmp' && mv '$1.tmp' '$1'"
}

prepare_env() {  # <release dir on host>
  local rel="$1"
  if ! on_host "test -s $BASE/env/platform-api.env"; then
    log "first deploy: generating platform identity (owner = Owner Only email)"
    owner_email="$(secret_get /platform/core OWNER_EMAIL)"
    # Runs the platform's own init inside its image (it needs the workspace deps).
    out="$(on_host "cd $rel && docker build -q -f services/platform-api/Dockerfile -t hyperbolic-core-platform-init . >/dev/null &&
      docker run --rm -u \$(id -u):\$(id -g) -v $BASE/env:/out hyperbolic-core-platform-init \
      node src/cli.ts init --env /out/platform-api.env --email '$owner_email' --public-url http://platform.localhost:8400")"
    sed -n 's/.*password: \([^ ]*\).*/\1/p' <<<"$out" | secret_put /platform/core PLATFORM_OWNER_PASSWORD
    unset out
  fi
  platform_env="$(on_host "cat $BASE/env/platform-api.env")"
  val() { sed -n "s/^$1=//p" <<<"$platform_env"; }
  # build.env: public values only (compiled into the browser bundle).
  printf 'PUBLIC_ORIGIN=https://core.kylegsmith.com\nPLATFORM_ANON_KEY=%s\n' "$(val PLATFORM_ANON_KEY)" | put_file "$BASE/env/build.env"
  {
    echo "LIFEOS_PLATFORM_URL=http://platform.localhost:8400"
    echo "LIFEOS_OWNER_USER_ID=$(val PLATFORM_OWNER_ID)"
    echo "ANTHROPIC_API_KEY=$(secret_get /platform/lifeos-deploy ANTHROPIC_API_KEY)"
    echo "LIFEOS_BRIEFING_TZ=$(secret_get /platform/lifeos-deploy LIFEOS_BRIEFING_TZ)"
  } | put_file "$BASE/env/lifeos.env"
  {
    echo "PLATFORM_URL=http://platform.localhost:8400"
    echo "PLATFORM_ANON_KEY=$(val PLATFORM_ANON_KEY)"
    echo "PLATFORM_SERVICE_KEY=$(val PLATFORM_SERVICE_KEY)"
  } | put_file "$BASE/env/brain.env"
  unset platform_env
  # Brain's provider: the ACC vault holds its own Anthropic key (ADR-05).
  on_host "mkdir -p $BASE/var/brain/acc-root && { test -f $BASE/var/brain/acc-root/policy.json || cp $rel/apps/agentic-command-center/backend/policy.json $BASE/var/brain/acc-root/policy.json; }"
  secret_get /brain BRAIN_ANTHROPIC_API_KEY | put_file "$BASE/env/brain-anthropic-api-key"
  on_host "chmod 0400 $BASE/env/brain-anthropic-api-key"
  secret_get /brain BRAIN_ANTHROPIC_API_KEY | python3 -c 'import json,sys;print(json.dumps({"ANTHROPIC_API_KEY":sys.stdin.read().strip()}))' |
    put_file "$BASE/var/brain/acc-root/vault.json"
  # Off-host backups: restic to the Storage Box "hyperbolic-backups" over SFTP.
  secret_get /platform/backup STORAGEBOX_SSH_KEY | put_file "$BASE/env/storagebox.key"
  {
    echo "RESTIC_PASSWORD=$(secret_get /platform/backup RESTIC_PASSWORD)"
    echo "RESTIC_REPOSITORY=sftp:storagebox:hyperbolic-core"
  } | put_file "$BASE/env/restic.env"
  on_host "mkdir -p ~/.ssh && cat > ~/.ssh/config <<'CFG'
Host storagebox
  HostName ${STORAGEBOX_USER:-u657401}.your-storagebox.de
  User ${STORAGEBOX_USER:-u657401}
  Port 23
  IdentityFile $BASE/env/storagebox.key
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
CFG
chmod 600 ~/.ssh/config"
  # systemd: boot start, nightly backup, 5-minute monitor.
  on_host "sudo install -m 0644 $rel/ops/cloud/host/hyperbolic-core*.service $rel/ops/cloud/host/hyperbolic-core*.timer /etc/systemd/system/ &&
    sudo systemctl daemon-reload && sudo systemctl enable hyperbolic-core.service hyperbolic-core-backup.timer hyperbolic-core-monitor.timer >/dev/null 2>&1 &&
    sudo systemctl start hyperbolic-core-backup.timer hyperbolic-core-monitor.timer"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  ssh) on_host "$@" ;;
  deploy)
    sha="$(git -C "$repo" rev-parse "${1:-HEAD}")"
    rel="$BASE/releases/$sha"
    log "shipping $sha"
    git -C "$repo" archive --format=tar "$sha" |
      on_host "rm -rf $rel.stage && mkdir -p $rel.stage && tar -x -C $rel.stage"
    prepare_env "$rel.stage"
    # The broker's deny-by-default policy for this exact commit (#504's generator).
    git -C "$repo" worktree add -q --detach "$work/src" "$sha"
    (cd "$work/src" && ln -s "$repo/node_modules" node_modules &&
      node packages/manifest-tools/generate-broker-policy.mjs --out "$work/broker-policy.json" >/dev/null)
    git -C "$repo" worktree remove --force "$work/src"
    on_host "mkdir -p $BASE/var/broker"
    put_file "$BASE/var/broker/broker-policy.json" < "$work/broker-policy.json"
    on_host "chmod 0644 $BASE/var/broker/broker-policy.json"   # public policy; the broker runs as its own user
    git -C "$repo" archive --format=tar "$sha" |
      on_host "bash $rel.stage/ops/cloud/host/deploy.sh $sha; rc=\$?; rm -rf $rel.stage; exit \$rc"
    "$0" smoke
    ;;
  rollback) on_host "bash \$(readlink -f $BASE/previous)/ops/cloud/host/deploy.sh --rollback" ;;
  backup) on_host "$BASE/current/ops/cloud/host/backup.sh" ;;
  smoke)
    # The owner's journey, run on the host against the edge: sign in, owner
    # check, registry, LifeOS write + read-back, Brain health and run list.
    { secret_get /platform/core OWNER_EMAIL; secret_get /platform/core PLATFORM_OWNER_PASSWORD; } |
      on_host "python3 $BASE/current/ops/cloud/host/journey.py"
    ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
