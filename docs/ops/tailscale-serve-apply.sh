#!/usr/bin/env bash
# Apply the single-origin route table from docs/planning/10-cicd-deployment.md.
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

mounts=("/" "/life/" "/life/api/")
deploy_root="/home/deploy"
if [[ -n "${NODE_TEST_CONTEXT:-}" && -n "${TAILSCALE_SERVE_TEST_ROOT:-}" ]]; then
  deploy_root="$TAILSCALE_SERVE_TEST_ROOT"
fi
targets=(
  "${deploy_root}/shell/current"
  "${deploy_root}/lifeos-ui/dist"
  "http://127.0.0.1:8000"
)

preflight() {
  command -v tailscale >/dev/null || {
    echo "error: tailscale is not installed" >&2
    return 1
  }
  [[ -f "${targets[0]}/healthz" && "$(<"${targets[0]}/healthz")" == '{"status":"ok"}' ]] || {
    echo "error: Shell release or health asset is missing: ${targets[0]}" >&2
    return 1
  }
  [[ -f "${targets[1]}/index.html" ]] || {
    echo "error: LifeOS release is missing: ${targets[1]}" >&2
    return 1
  }
  grep -Eq '(src|href)="/life/' "${targets[1]}/index.html" || {
    echo "error: LifeOS was not built for the /life/ base path" >&2
    return 1
  }
  command -v curl >/dev/null || {
    echo "error: curl is not installed" >&2
    return 1
  }
  curl -fsS --max-time 5 "${targets[2]}/healthz" >/dev/null || {
    echo "error: LifeOS API health check failed: ${targets[2]}/healthz" >&2
    return 1
  }
  tailscale serve status >/dev/null
}

if [[ "$mode" == "--apply" ]]; then
  preflight
  trap 'echo "error: route application stopped early; fix the cause and rerun --apply" >&2' ERR
fi

for index in "${!mounts[@]}"; do
  command=(
    tailscale serve --bg --yes --https=443
    "--set-path=${mounts[$index]}"
    "${targets[$index]}"
  )
  if [[ "$mode" == "--dry-run" ]]; then
    print_command "${command[@]}"
  else
    printf '+ '
    print_command "${command[@]}"
    "${command[@]}"
  fi
done

if [[ "$mode" == "--apply" ]]; then
  trap - ERR
  tailscale serve status
fi
