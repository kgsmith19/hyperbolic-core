#!/usr/bin/env bash
# VPS bootstrap from nothing (m1-13, docs/planning/issues/m1-13-chore-platform-production-bootstrap.md).
# Run ONCE, as root, on a fresh VPS already joined to the tailnet (or pass
# --tailnet-authkey to join it here too). Collapses runbook.md's "VPS
# bootstrap" manual steps 2-3 into one idempotent script; step 1 (approving
# the device in the tailnet admin console, if the ACL requires manual
# approval for non-tag:ci devices) and step 4 (the first real CI dispatch)
# still happen outside this script by design -- neither is scriptable from
# inside the box being bootstrapped.
#
# NO SSH KEYS, deliberately (ADR 008, issue #191): deploy authentication is
# keyless Tailscale SSH -- CI runners join the tailnet as ephemeral tag:ci
# nodes and the tailnet ACL grants tag:ci SSH to deploy@<this box>. This
# script therefore generates no key material and installs no per-key trust
# entries on the box;
# it only ensures Tailscale SSH is enabled on the box (`tailscale up --ssh`
# when joining here; run `tailscale set --ssh` yourself if the box joined
# without it) and that the deploy user and its directories exist. The ACL
# grant itself lives in the tailnet admin console, outside this repository.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: bootstrap-vps.sh [--dry-run|--apply] [--tailnet-authkey=KEY]

  --dry-run              Print every command this script would run. Default.
  --apply                Run for real. Must be root (or sudo).
  --tailnet-authkey=KEY  Also run `tailscale up --authkey=KEY --ssh` first.
                          Omit to join the tailnet yourself (with --ssh, so
                          Tailscale SSH is enabled) before running this.

Provisions no secrets and prints none: deploy authentication is keyless
Tailscale SSH (ADR 008) -- the tailnet ACL granting tag:ci SSH to deploy@
is configured in the tailnet admin console, not on this box.
EOF
}

mode="--dry-run"
authkey=""
for arg in "$@"; do
  case "$arg" in
    --dry-run | --apply) mode="$arg" ;;
    --tailnet-authkey=*) authkey="${arg#--tailnet-authkey=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

deploy_user="deploy"
deploy_home="/home/deploy"
if [[ -n "${NODE_TEST_CONTEXT:-}" && -n "${BOOTSTRAP_VPS_TEST_ROOT:-}" ]]; then
  deploy_home="$BOOTSTRAP_VPS_TEST_ROOT"
fi

target_dirs=(shell lifeos-ui llm-handler brain broker)

print_cmd() {
  printf '+ %q' "$1"
  shift
  printf ' %q' "$@"
  printf '\n'
}

run() {
  if [[ "$mode" == "--dry-run" ]]; then
    print_cmd "$@"
  else
    print_cmd "$@"
    "$@"
  fi
}

if [[ "$mode" == "--apply" && "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "error: --apply must run as root (this box's own useradd needs it)" >&2
  exit 1
fi

if [[ -n "$authkey" ]]; then
  run tailscale up "--authkey=$authkey" --ssh
fi

if [[ "$mode" == "--dry-run" ]]; then
  print_cmd id "$deploy_user"
  echo "  (if that fails:)"
  print_cmd useradd -m -s /bin/bash "$deploy_user"
elif ! id "$deploy_user" >/dev/null 2>&1; then
  run useradd -m -s /bin/bash "$deploy_user"
fi

for dir in "${target_dirs[@]}"; do
  run mkdir -p "$deploy_home/$dir"
done

# Shared --internal Docker network (issue #187 Phase 0 slice B): the
# llm-handler and broker compose projects both join platform-internal
# (additively, on top of each project's own default bridge). deploy.yml's
# deploy-llm-handler and deploy-broker jobs create it idempotently before
# every compose up too; creating it here as well means a rebuilt VPS has it
# before the first deploy ever runs. Guarded the same way as useradd above:
# an existing network is left untouched, so reruns stay no-ops.
if [[ "$mode" == "--dry-run" ]]; then
  print_cmd docker network inspect platform-internal
  echo "  (if that fails:)"
  print_cmd docker network create --internal platform-internal
elif ! docker network inspect platform-internal >/dev/null 2>&1; then
  run docker network create --internal platform-internal
fi

if [[ "$mode" == "--dry-run" ]]; then
  print_cmd chown -R "$deploy_user:$deploy_user" "$deploy_home"
  exit 0
fi

run chown -R "$deploy_user:$deploy_user" "$deploy_home"
