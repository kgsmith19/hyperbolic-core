#!/usr/bin/env bash
# Converge the legacy five-mount table to one private nginx origin.
set -euo pipefail

usage() {
  echo "usage: $0 [--dry-run|--apply|--classify-status]" >&2
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
  --dry-run | --apply | --classify-status) ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
esac

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
private_origin_verifier="$script_directory/verify-private-origin.sh"

sudo_prefix=(sudo)
if [[ -n "${NODE_TEST_CONTEXT:-}" && -n "${TAILSCALE_SERVE_TEST_ROOT:-}" ]]; then
  sudo_prefix=()
fi
root_command=(
  "${sudo_prefix[@]}"
  tailscale serve --bg --yes --https=443 --set-path=/
  http://127.0.0.1:8080
)
legacy_mounts=(/life/ /life/api/ /api/ /api/brain/)
removal=()

removal_command() {
  local mount="$1"
  removal=(
    "${sudo_prefix[@]}"
    tailscale serve --yes --https=443 "--set-path=$mount" off
  )
}

preflight() {
  command -v tailscale >/dev/null || {
    echo "error: tailscale is not installed" >&2
    return 1
  }
  command -v curl >/dev/null || {
    echo "error: curl is not installed" >&2
    return 1
  }
  command -v python3 >/dev/null || {
    echo "error: python3 is not installed" >&2
    return 1
  }
  if [[ ! -x "$private_origin_verifier" ]]; then
    echo "error: private origin verifier is missing or not executable: $private_origin_verifier" >&2
    return 1
  fi
  local health_response
  health_response="$(curl -fsS --max-time 5 http://127.0.0.1:8080/healthz)" || {
    echo "error: private nginx origin health check failed: http://127.0.0.1:8080/healthz" >&2
    return 1
  }
  [[ "$health_response" == '{"status":"ok"}' ]] || {
    echo "error: unexpected private nginx origin health response" >&2
    return 1
  }
  "$private_origin_verifier" http://127.0.0.1:8080 || {
    echo "error: content-aware private origin verification failed" >&2
    return 1
  }
}

validate_initial_json() {
  SERVE_STATUS_JSON="$1" python3 <<'PY'
import json
import os
import sys

def fail(reason):
    print(
        f"error: initial Serve state is not a supported migration state: {reason}",
        file=sys.stderr,
    )
    raise SystemExit(1)

try:
    state = json.loads(os.environ["SERVE_STATUS_JSON"])
except (KeyError, json.JSONDecodeError) as error:
    print(f"error: invalid initial Serve JSON: {error}", file=sys.stderr)
    raise SystemExit(1)

if state is None:
    raise SystemExit(0)
if not isinstance(state, dict):
    fail("top-level value is neither null nor an object")

known_fields = {"TCP", "Web", "Services", "AllowFunnel", "Foreground", "ETag", "Version", "Config"}
unknown_fields = set(state) - known_fields
if unknown_fields:
    fail(f"unknown top-level fields: {', '.join(sorted(unknown_fields))}")

for field in ("Services", "Foreground"):
    if field in state and state[field]:
        if not isinstance(state[field], dict):
            fail(f"{field} must be an object when present")
        if len(state[field]) > 0:
            fail(f"{field} is populated")

if "AllowFunnel" in state and state["AllowFunnel"] not in (False, None, {}):
    if not isinstance(state["AllowFunnel"], (bool, dict)):
        fail("AllowFunnel has unexpected type")

tcp = state.get("TCP", {})
if not isinstance(tcp, dict):
    fail("TCP must be an object when present")
if tcp:
    if set(tcp) != {"443"}:
        fail("TCP must be empty or contain only HTTPS 443")
    listener = tcp["443"]
    if (
        not isinstance(listener, dict)
        or listener != {"HTTPS": True}
        or listener.get("HTTPS") is not True
    ):
        fail("TCP 443 must be exactly an HTTPS listener")

web = state.get("Web", {})
if not isinstance(web, dict):
    fail("Web must be empty or an object")
if len(web) > 1:
    fail("Web contains more than one host")

allowed_handlers = {
    "/": (
        {"Path": "/home/deploy/shell/current"},
        {"Proxy": "http://127.0.0.1:8080"},
    ),
    "/life/": ({"Path": "/home/deploy/lifeos-ui/current"},),
    "/life/api/": ({"Proxy": "http://127.0.0.1:8000"},),
    "/api/": ({"Proxy": "http://127.0.0.1:8200"},),
    "/api/brain/": ({"Proxy": "http://127.0.0.1:8100"},),
}

if web:
    host, host_state = next(iter(web.items()))
    if not isinstance(host, str) or not host.endswith(":443"):
        fail("the Web host must use HTTPS port 443")
    if not isinstance(host_state, dict):
        fail("the Web host state must be an object")
    if not set(host_state).issubset({"Handlers"}):
        fail("the Web host contains fields other than Handlers")
    handlers = host_state.get("Handlers", {})
    if not isinstance(handlers, dict):
        fail("Handlers must be an object")
    for route, handler in handlers.items():
        if route not in allowed_handlers:
            fail(f"unsupported handler path: {route}")
        if not isinstance(handler, dict) or handler not in allowed_handlers[route]:
            fail(f"unexpected handler target or fields for {route}")
        if route != "/":
            print(route)
PY
}

verify_one_root_json() {
  SERVE_STATUS_JSON="$1" python3 <<'PY'
import json
import os
import sys

def fail(reason):
    print(
        f"error: final Serve state is not exactly one nginx root proxy: {reason}",
        file=sys.stderr,
    )
    raise SystemExit(1)

try:
    state = json.loads(os.environ["SERVE_STATUS_JSON"])
except (KeyError, json.JSONDecodeError) as error:
    print(f"error: invalid final Serve JSON: {error}", file=sys.stderr)
    raise SystemExit(1)

if not isinstance(state, dict):
    fail("top-level value is not an object")

known_fields = {"TCP", "Web", "Services", "AllowFunnel", "Foreground", "ETag", "Version", "Config"}
unexpected = set(state) - known_fields
if unexpected:
    fail(f"unexpected top-level fields: {', '.join(sorted(unexpected))}")

for field in ("Services", "Foreground"):
    if field in state and state[field]:
        if not isinstance(state[field], dict):
            fail(f"{field} must be an object when present")
        if len(state[field]) > 0:
            fail(f"{field} is populated")

if "AllowFunnel" in state and state["AllowFunnel"] not in (False, None, {}):
    if not isinstance(state["AllowFunnel"], (bool, dict)):
        fail("AllowFunnel has unexpected type")

tcp = state.get("TCP")
if not isinstance(tcp, dict) or set(tcp) != {"443"}:
    fail("TCP must contain only the HTTPS 443 listener")
listener = tcp["443"]
if (
    not isinstance(listener, dict)
    or listener != {"HTTPS": True}
    or listener.get("HTTPS") is not True
):
    fail("TCP 443 is not exactly an HTTPS listener")

web = state.get("Web")
if not isinstance(web, dict) or len(web) != 1:
    fail("Web must contain exactly one host")
host, host_state = next(iter(web.items()))
if not isinstance(host, str) or not host.endswith(":443"):
    fail("the Web host must use HTTPS port 443")
if not isinstance(host_state, dict) or set(host_state) != {"Handlers"}:
    fail("the Web host must contain only Handlers")
handlers = host_state["Handlers"]
if not isinstance(handlers, dict) or set(handlers) != {"/"}:
    fail("Handlers must contain only /")
root = handlers["/"]
if not isinstance(root, dict) or root != {"Proxy": "http://127.0.0.1:8080"}:
    fail("/ does not proxy exactly to http://127.0.0.1:8080")
PY
}

if [[ "$mode" == "--classify-status" ]]; then
  classifier_status="$("${sudo_prefix[@]}" tailscale serve status --json 2>/dev/null || tailscale serve status --json 2>/dev/null || true)"
  if [[ -n "$classifier_status" ]] && verify_one_root_json "$classifier_status" >/dev/null 2>&1; then
    printf 'gateway\n'
  else
    printf 'legacy\n'
  fi
  exit 0
fi

if [[ "$mode" == "--dry-run" ]]; then
  print_command "${root_command[@]}"
  for mount in "${legacy_mounts[@]}"; do
    removal_command "$mount"
    print_command "${removal[@]}"
  done
  exit 0
fi

preflight

if ! initial_status="$("${sudo_prefix[@]}" tailscale serve status --json)"; then
  echo "error: initial Serve status check failed; no Serve mutation was attempted" >&2
  exit 1
fi
printf 'Serve status JSON before convergence:\n%s\n' "$initial_status"
if ! present_mounts="$(validate_initial_json "$initial_status")"; then
  echo "error: initial Serve state validation failed; no Serve mutation was attempted" >&2
  exit 1
fi
declare -A legacy_present=()
if [[ -n "$present_mounts" ]]; then
  while IFS= read -r mount; do
    legacy_present["$mount"]=1
  done <<< "$present_mounts"
fi

printf '+ '
print_command "${root_command[@]}"
if ! "${root_command[@]}"; then
  echo "error: nginx root proxy installation failed; legacy routes were not changed" >&2
  exit 1
fi

remove_legacy_mount() {
  local mount="$1"
  removal_command "$mount"
  printf '+ '
  print_command "${removal[@]}"
  "${removal[@]}"
}

for mount in "${legacy_mounts[@]}"; do
  if [[ -z "${legacy_present[$mount]:-}" ]]; then
    echo "legacy mount $mount is already absent; skipping" >&2
    continue
  fi
  if ! remove_legacy_mount "$mount"; then
    echo "error: failed to remove legacy mount $mount; the nginx root proxy remains active and later legacy routes were not changed" >&2
    if diagnostic_status="$("${sudo_prefix[@]}" tailscale serve status --json)"; then
      printf 'Serve status JSON after removal failure:\n%s\n' "$diagnostic_status" >&2
    fi
    exit 1
  fi
done

if ! final_status="$("${sudo_prefix[@]}" tailscale serve status --json)"; then
  echo "error: final Serve status check failed; the nginx root proxy remains configured" >&2
  exit 1
fi
printf 'Serve status JSON after convergence:\n%s\n' "$final_status"
verify_one_root_json "$final_status"
