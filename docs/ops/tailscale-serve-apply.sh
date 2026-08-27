#!/usr/bin/env bash
# Replace the legacy five-mount table with one private nginx origin.
set -euo pipefail

usage() {
  echo "usage: $0 [--dry-run|--apply]" >&2
}

print_command() {
  printf '%q' "$1"
  shift
  printf ' %q' "$@"
  printf '\n'
}

if (( $# > 1 )); then
  usage
  exit 2
fi

mode="${1:---dry-run}"
case "$mode" in
  --dry-run | --apply) ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
esac

sudo_prefix=(sudo)
if [[ -n "${NODE_TEST_CONTEXT:-}" && -n "${TAILSCALE_SERVE_TEST_ROOT:-}" ]]; then
  sudo_prefix=()
fi
reset_command=("${sudo_prefix[@]}" tailscale serve reset)
apply_command=(
  "${sudo_prefix[@]}"
  tailscale serve --bg --yes --https=443 --set-path=/
  http://127.0.0.1:8080
)

preflight() {
  command -v tailscale >/dev/null || {
    echo "error: tailscale is not installed" >&2
    return 1
  }
  command -v curl >/dev/null || {
    echo "error: curl is not installed" >&2
    return 1
  }
  local health_response
  health_response="$(curl -fsS --max-time 5 http://127.0.0.1:8080/healthz)" || {
    echo "error: private nginx origin health check failed: http://127.0.0.1:8080/healthz" >&2
    return 1
  }
  [[ "$health_response" == '{"status":"ok"}' ]] || {
    echo "error: unexpected private nginx origin health response" >&2
    return 1
  }
  tailscale serve status >/dev/null
}

if [[ "$mode" == "--dry-run" ]]; then
  print_command "${reset_command[@]}"
  print_command "${apply_command[@]}"
  exit 0
fi

preflight
trap 'echo "error: Serve migration stopped early; use the documented rollback commands in docs/ops/runbook.md before retrying" >&2' ERR
printf '+ '
print_command "${reset_command[@]}"
"${reset_command[@]}"
printf '+ '
print_command "${apply_command[@]}"
"${apply_command[@]}"
trap - ERR
tailscale serve status
