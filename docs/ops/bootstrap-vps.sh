#!/usr/bin/env bash
# VPS bootstrap from nothing (m1-13, docs/planning/issues/m1-13-chore-platform-production-bootstrap.md).
# Run ONCE, as root, on a fresh VPS already joined to the tailnet (or pass
# --tailnet-authkey to join it here too). Collapses runbook.md's "VPS
# bootstrap" manual steps 2-4 into one idempotent script; step 1 (approving
# the device in the tailnet admin console, if the ACL requires manual
# approval for non-tag:ci devices) and step 5 (the first real CI dispatch)
# still happen outside this script by design -- neither is scriptable from
# inside the box being bootstrapped.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: bootstrap-vps.sh [--dry-run|--apply] [--tailnet-authkey=KEY]

  --dry-run              Print every command this script would run. Default.
  --apply                Run for real. Must be root (or sudo).
  --tailnet-authkey=KEY  Also run `tailscale up --authkey=KEY` first. Omit to
                          join the tailnet yourself before running this script.

Prints the four deploy-key PRIVATE halves to stdout ONCE at the end of a
successful --apply run (SHELL_DEPLOY_SSH_KEY, LLM_HANDLER_SSH_KEY,
BRAIN_DEPLOY_SSH_KEY, BROKER_DEPLOY_SSH_KEY) -- copy them into Infisical
immediately. The key files themselves are shredded from disk before this
script exits; if you lose the printed output, rerun with --apply to
generate a fresh pair (and update the matching authorized_keys entry +
Infisical value together).
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
authorized_keys="$deploy_home/.ssh/authorized_keys"

# name -> (infisical path, infisical variable name) -- the exact pairing
# runbook.md's "Shell/Handler A/Brain/broker deployment" sections already document.
key_names=(shell-deploy llm-handler-deploy brain-deploy broker-deploy)
key_paths=("/platform/shell-deploy/" "/platform/llm-handler/" "/brain/" "/platform/broker/")
key_vars=(SHELL_DEPLOY_SSH_KEY LLM_HANDLER_SSH_KEY BRAIN_DEPLOY_SSH_KEY BROKER_DEPLOY_SSH_KEY)
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
  echo "error: --apply must run as root (this box's own useradd/authorized_keys need it)" >&2
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
run mkdir -p "$deploy_home/.ssh"

if [[ "$mode" == "--dry-run" ]]; then
  for i in "${!key_names[@]}"; do
    print_cmd ssh-keygen -t ed25519 -N "" -C "${key_names[$i]}@hyperbolic-core" -f "/run/${key_names[$i]}_key"
    echo "  (append \"/run/${key_names[$i]}_key.pub\" to $authorized_keys)"
  done
  echo "(then print each private key once, install ownership/permissions, and shred the key files)"
  exit 0
fi

run chmod 700 "$deploy_home/.ssh"
run touch "$authorized_keys"

keydir="$(mktemp -d)"
trap 'shred -u "$keydir"/*_key 2>/dev/null || rm -f "$keydir"/*_key; rm -rf "$keydir"' EXIT

printed=()
for i in "${!key_names[@]}"; do
  name="${key_names[$i]}"
  keyfile="$keydir/${name}_key"
  run ssh-keygen -t ed25519 -N "" -C "${name}@hyperbolic-core" -f "$keyfile"
  pub="$(cat "$keyfile.pub")"
  # Rotation-safe, not merely append-once: a rerun (e.g. to replace a lost
  # private key) must retire the OLD public half for this same key name, or
  # every past run leaves a dead-but-still-trusted key in authorized_keys
  # forever. Match on the trailing `ssh-keygen -C` comment, which is unique
  # per key name and stable across regenerations.
  if [[ -f "$authorized_keys" ]] && grep -qF " ${name}@hyperbolic-core" "$authorized_keys"; then
    grep -vF " ${name}@hyperbolic-core" "$authorized_keys" >"$authorized_keys.tmp"
    mv "$authorized_keys.tmp" "$authorized_keys"
  fi
  printf '%s\n' "$pub" >>"$authorized_keys"
  printed+=("${key_vars[$i]}=${key_paths[$i]}::$(cat "$keyfile")")
  rm -f "$keyfile.pub"
done

run chmod 600 "$authorized_keys"
run chown -R "$deploy_user:$deploy_user" "$deploy_home"

echo
echo "=== COPY THESE INTO INFISICAL NOW -- SHOWN ONCE, KEY FILES ARE ABOUT TO BE SHREDDED ==="
for entry in "${printed[@]}"; do
  var="${entry%%=*}"
  rest="${entry#*=}"
  path="${rest%%::*}"
  value="${rest#*::}"
  echo
  echo "--- $var (path $path) ---"
  echo "$value"
done
echo
echo "=== end ==="
