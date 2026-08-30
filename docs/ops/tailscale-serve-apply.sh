#!/usr/bin/env bash
# Converge the legacy multi-mount/listener table to one private nginx origin.
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
legacy_https_removal=(
  "${sudo_prefix[@]}"
  tailscale serve --yes --https=8443 off
)

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

LEGACY_8443_PATHS = {
    "/home/deploy/lifeos-ui/current",
    "/home/deploy/lifeos-ui/dist",
}


def fail(reason):
    print(
        f"error: initial Serve state is not a supported migration state: {reason}",
        file=sys.stderr,
    )
    raise SystemExit(1)


def split_host_port(value):
    host, separator, port = value.rpartition(":")
    if not separator or not host or not port.isdigit():
        fail(f"unsupported Web host key: {value}")
    return host, port


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
    fail(f"AllowFunnel indicates Funnel is enabled: {state['AllowFunnel']!r}")

tcp = state.get("TCP", {})
if not isinstance(tcp, dict):
    fail("TCP must be an object when present")
unexpected_ports = set(tcp) - {"443", "8443"}
if unexpected_ports:
    fail(f"unsupported TCP listeners: {', '.join(sorted(unexpected_ports))}")
for port, listener in tcp.items():
    if not isinstance(listener, dict) or listener != {"HTTPS": True}:
        fail(f"TCP {port} must be exactly an HTTPS listener")

web = state.get("Web", {})
if not isinstance(web, dict):
    fail("Web must be empty or an object")

hosts_by_port = {"443": [], "8443": []}
for web_host in web:
    _, port = split_host_port(web_host)
    if port not in hosts_by_port:
        fail(f"unsupported Web HTTPS listener: {web_host}")
    hosts_by_port[port].append(web_host)
for port, hosts in hosts_by_port.items():
    if len(hosts) > 1:
        fail(f"multiple Web hosts exist for HTTPS {port}")
    if (port in tcp) != bool(hosts):
        fail(f"TCP/Web state disagrees for HTTPS {port}")

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

if hosts_by_port["443"]:
    host_443 = hosts_by_port["443"][0]
    host_state = web[host_443]
    if not isinstance(host_state, dict):
        fail("the Web 443 host state must be an object")
    if not set(host_state).issubset({"Handlers"}):
        fail("the Web 443 host contains fields other than Handlers")
    handlers = host_state.get("Handlers", {})
    if not isinstance(handlers, dict):
        fail("Web 443 Handlers must be an object")
    for route, handler in handlers.items():
        if route not in allowed_handlers:
            fail(f"unsupported handler path: {route}")
        if not isinstance(handler, dict) or handler not in allowed_handlers[route]:
            fail(f"unexpected handler target or fields for {route}")
        if route != "/":
            print(route)

if hosts_by_port["8443"]:
    host_8443 = hosts_by_port["8443"][0]
    host_state = web[host_8443]
    if not isinstance(host_state, dict) or set(host_state) != {"Handlers"}:
        fail("legacy Web 8443 host must contain only Handlers")
    handlers = host_state.get("Handlers")
    if not isinstance(handlers, dict) or set(handlers) != {"/"}:
        fail("legacy Web 8443 Handlers must contain only /")
    root = handlers["/"]
    if not isinstance(root, dict) or set(root) != {"Path"} or root.get("Path") not in LEGACY_8443_PATHS:
        fail("HTTPS 8443 is not the documented legacy LifeOS path listener")
    if hosts_by_port["443"]:
        host_443_name, _ = split_host_port(hosts_by_port["443"][0])
        host_8443_name, _ = split_host_port(host_8443)
        if host_443_name != host_8443_name:
            fail("HTTPS 443 and legacy 8443 belong to different Web hosts")
PY
}

verify_gateway_json() {
  SERVE_STATUS_JSON="$1" ALLOW_LEGACY_8443="$2" python3 <<'PY'
import json
import os
import sys

LEGACY_8443_PATHS = {
    "/home/deploy/lifeos-ui/current",
    "/home/deploy/lifeos-ui/dist",
}
allow_legacy_8443 = os.environ.get("ALLOW_LEGACY_8443") == "true"


def fail(reason):
    print(
        f"error: Serve state is not the required nginx gateway topology: {reason}",
        file=sys.stderr,
    )
    raise SystemExit(1)


def split_host_port(value):
    host, separator, port = value.rpartition(":")
    if not separator or not host or not port.isdigit():
        fail(f"unsupported Web host key: {value}")
    return host, port


try:
    state = json.loads(os.environ["SERVE_STATUS_JSON"])
except (KeyError, json.JSONDecodeError) as error:
    print(f"error: invalid Serve JSON: {error}", file=sys.stderr)
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
    fail(f"AllowFunnel indicates Funnel is enabled: {state['AllowFunnel']!r}")

tcp = state.get("TCP", {})
if not isinstance(tcp, dict):
    fail("TCP must be an object")
expected_ports = {"443", "8443"} if allow_legacy_8443 and "8443" in tcp else {"443"}
if set(tcp) != expected_ports:
    fail(f"TCP listeners must be exactly {', '.join(sorted(expected_ports))}")
for port, listener in tcp.items():
    if not isinstance(listener, dict) or listener != {"HTTPS": True}:
        fail(f"TCP {port} must be exactly an HTTPS listener")

web = state.get("Web", {})
if not isinstance(web, dict):
    fail("Web must be an object")
hosts_by_port = {"443": [], "8443": []}
for web_host in web:
    _, port = split_host_port(web_host)
    if port not in hosts_by_port:
        fail(f"unexpected Web HTTPS listener: {web_host}")
    hosts_by_port[port].append(web_host)
if len(hosts_by_port["443"]) != 1:
    fail("Web must contain exactly one HTTPS 443 host")
if allow_legacy_8443 and "8443" in tcp:
    if len(hosts_by_port["8443"]) != 1:
        fail("legacy TCP 8443 must have exactly one Web host")
else:
    if hosts_by_port["8443"]:
        fail("Web contains an unexpected HTTPS 8443 host")
expected_web_count = 2 if allow_legacy_8443 and "8443" in tcp else 1
if len(web) != expected_web_count:
    fail("Web contains an unexpected host")

host_443 = hosts_by_port["443"][0]
host_state = web[host_443]
if not isinstance(host_state, dict) or set(host_state) != {"Handlers"}:
    fail("the Web 443 host must contain only Handlers")
handlers = host_state.get("Handlers", {})
if not isinstance(handlers, dict) or set(handlers) != {"/"}:
    fail("Web 443 Handlers must contain only /")
root = handlers["/"]
if not isinstance(root, dict) or root != {"Proxy": "http://127.0.0.1:8080"}:
    fail("Web 443 / does not proxy exactly to http://127.0.0.1:8080")

if allow_legacy_8443 and "8443" in tcp:
    host_8443 = hosts_by_port["8443"][0]
    host_state = web[host_8443]
    if not isinstance(host_state, dict) or set(host_state) != {"Handlers"}:
        fail("legacy Web 8443 host must contain only Handlers")
    handlers = host_state.get("Handlers")
    if not isinstance(handlers, dict) or set(handlers) != {"/"}:
        fail("legacy Web 8443 Handlers must contain only /")
    legacy_root = handlers["/"]
    if not isinstance(legacy_root, dict) or set(legacy_root) != {"Path"} or legacy_root.get("Path") not in LEGACY_8443_PATHS:
        fail("HTTPS 8443 is not the documented legacy LifeOS path listener")
    host_443_name, _ = split_host_port(host_443)
    host_8443_name, _ = split_host_port(host_8443)
    if host_443_name != host_8443_name:
        fail("HTTPS 443 and legacy 8443 belong to different Web hosts")
PY
}

legacy_8443_present_json() {
  SERVE_STATUS_JSON="$1" python3 <<'PY'
import json
import os
state = json.loads(os.environ["SERVE_STATUS_JSON"])
print("true" if isinstance(state, dict) and "8443" in state.get("TCP", {}) else "false")
PY
}

gateway_origin_from_json() {
  SERVE_STATUS_JSON="$1" python3 <<'PY'
import json
import os
state = json.loads(os.environ["SERVE_STATUS_JSON"])
web = state["Web"]
host_443 = next(key for key in web if key.endswith(":443"))
host = host_443[:-4]
print(f"https://{host}")
PY
}

if [[ "$mode" == "--classify-status" ]]; then
  classifier_status="$("${sudo_prefix[@]}" tailscale serve status --json 2>/dev/null || tailscale serve status --json 2>/dev/null || true)"
  if [[ -n "$classifier_status" ]] && verify_gateway_json "$classifier_status" false >/dev/null 2>&1; then
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

if ! gateway_status="$("${sudo_prefix[@]}" tailscale serve status --json)"; then
  echo "error: gateway Serve status check failed; legacy HTTPS 8443 was not changed" >&2
  exit 1
fi
printf 'Serve status JSON before legacy HTTPS retirement:\n%s\n' "$gateway_status"
if ! verify_gateway_json "$gateway_status" true; then
  echo "error: HTTPS 443 is not the exact nginx gateway (optionally plus the known LifeOS 8443 listener); legacy HTTPS 8443 was not changed" >&2
  exit 1
fi

gateway_origin="$(gateway_origin_from_json "$gateway_status")"
if ! "$private_origin_verifier" "$gateway_origin"; then
  echo "error: live HTTPS 443 gateway verification failed at $gateway_origin; legacy HTTPS 8443 was not changed" >&2
  exit 1
fi

if [[ "$(legacy_8443_present_json "$gateway_status")" == "true" ]]; then
  printf '+ '
  print_command "${legacy_https_removal[@]}"
  if ! "${legacy_https_removal[@]}"; then
    echo "error: failed to retire the documented legacy LifeOS HTTPS 8443 listener; the verified 443 nginx gateway remains active" >&2
    if diagnostic_status="$("${sudo_prefix[@]}" tailscale serve status --json)"; then
      printf 'Serve status JSON after HTTPS 8443 retirement failure:\n%s\n' "$diagnostic_status" >&2
    fi
    exit 1
  fi
else
  echo "legacy HTTPS 8443 listener is already absent; skipping" >&2
fi

if ! final_status="$("${sudo_prefix[@]}" tailscale serve status --json)"; then
  echo "error: final Serve status check failed; the nginx root proxy remains configured" >&2
  exit 1
fi
printf 'Serve status JSON after convergence:\n%s\n' "$final_status"
verify_gateway_json "$final_status" false
