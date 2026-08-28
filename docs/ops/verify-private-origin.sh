#!/usr/bin/env bash
# Verify that the loopback nginx origin reaches each intended application.
set -euo pipefail

usage() {
  echo "usage: $0 [http://127.0.0.1:8080]" >&2
}

if (( $# > 1 )); then
  usage
  exit 2
fi

origin="${1:-http://127.0.0.1:8080}"
origin="${origin%/}"
if [[ -z "$origin" ]]; then
  usage
  exit 2
fi

command -v curl >/dev/null || {
  echo "error: curl is not installed" >&2
  exit 1
}
command -v python3 >/dev/null || {
  echo "error: python3 is not installed" >&2
  exit 1
}

temporary_directory=""
cleanup() {
  local original_status="$?"
  trap - EXIT INT TERM HUP
  set +e
  if [[ -n "$temporary_directory" && -d "$temporary_directory" ]]; then
    find "$temporary_directory" -mindepth 1 -maxdepth 1 -type f -delete
    rmdir "$temporary_directory"
  fi
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/hyperbolic-private-origin.XXXXXX")"
response_index=0
response_body=""
response_content_type=""
response_http_status=""

fetch_response() {
  local label="$1"
  local route="$2"
  local metadata
  response_index=$((response_index + 1))
  response_body="$temporary_directory/response-$response_index"
  if ! metadata="$({
    curl \
      --path-as-is \
      --silent \
      --show-error \
      --max-time 10 \
      --output "$response_body" \
      --write-out $'%{http_code}\n%{content_type}' \
      "$origin$route"
  })"; then
    echo "error: $label could not be fetched from $route" >&2
    return 1
  fi
  response_http_status="${metadata%%$'\n'*}"
  response_content_type="${metadata#*$'\n'}"
}

require_http_status() {
  local label="$1"
  local expected_status="$2"
  if [[ "$response_http_status" != "$expected_status" ]]; then
    echo "error: $label must return HTTP $expected_status (got $response_http_status)" >&2
    return 1
  fi
}

verify_document() {
  local label="$1"
  local route="$2"
  local bundle="$3"
  local marker="$4"
  local document
  fetch_response "$label" "$route"
  require_http_status "$label" "200"
  case "${response_content_type,,}" in
    text/html | text/html\;*) ;;
    *)
      echo "error: $label must return text/html for the $bundle bundle (got ${response_content_type:-none})" >&2
      return 1
      ;;
  esac
  document="$(<"$response_body")"
  if [[ ! "$document" =~ $marker ]]; then
    echo "error: $label did not return the $bundle bundle" >&2
    return 1
  fi
  printf 'ok: %s (%s bundle)\n' "$label" "$bundle"
}

verify_json_status() {
  local label="$1"
  local route="$2"
  fetch_response "$label" "$route"
  require_http_status "$label" "200"
  case "${response_content_type,,}" in
    application/json | application/json\;*) ;;
    *)
      echo "error: $label must return application/json (got ${response_content_type:-none})" >&2
      return 1
      ;;
  esac
  python3 - "$response_body" "$label" <<'PY'
import json
import sys

body_path, label = sys.argv[1:]
try:
    with open(body_path, encoding="utf-8") as response:
        body = json.load(response)
except (OSError, UnicodeError, json.JSONDecodeError) as error:
    print(f"error: {label} did not return valid JSON: {error}", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(body, dict):
    print(f"error: {label} must return a top-level JSON object", file=sys.stderr)
    raise SystemExit(1)
if body.get("status") != "ok":
    print(f"error: {label} JSON object must contain top-level status=ok", file=sys.stderr)
    raise SystemExit(1)
PY
  printf 'ok: %s (application/json status=ok)\n' "$label"
}

verify_not_found() {
  local label="$1"
  local route="$2"
  local require_non_html="$3"
  fetch_response "$label" "$route"
  require_http_status "$label" "404"
  if [[ "$require_non_html" == "true" ]]; then
    case "${response_content_type,,}" in
      text/html | text/html\;*)
        echo "error: $label must not return text/html (got ${response_content_type:-none})" >&2
        return 1
        ;;
    esac
  fi
  printf 'ok: %s (HTTP 404)\n' "$label"
}

shell_marker='src="/assets/[A-Za-z0-9_.-]+\.js"'
life_marker='src="/life/assets/[A-Za-z0-9_.-]+\.js"'

verify_document "Shell login" "/login" "Shell" "$shell_marker"
verify_document "Shell settings" "/settings" "Shell" "$shell_marker"
verify_document "Shell uppercase-byte query route" "/settings?return=/%41pi/../x" "Shell" "$shell_marker"
verify_document "LifeOS capture" "/life/capture" "LifeOS" "$life_marker"
verify_not_found "Missing Shell asset" "/assets/__ops_origin_missing__.js" "false"
verify_not_found "Missing LifeOS asset" "/life/assets/__ops_origin_missing__.js" "false"
verify_not_found "Handler API boundary" "/api/__ops_origin_boundary__.js" "true"
verify_not_found "Brain API boundary" "/api/brain/__ops_origin_boundary__.js" "true"
verify_not_found "LifeOS API boundary" "/life/api/__ops_origin_boundary__.js" "true"
verify_not_found "Root API encoded-separator exact traversal" "/%2Fapi/%2e%2e/settings" "true"
verify_not_found "Root API duplicate-separator traversal" "//api/../settings" "true"
verify_not_found "Root asset dot-prefix traversal" "/./assets/../settings" "true"
verify_not_found "LifeOS API encoded-separator exact traversal" "/%2Flife/api/%2e%2e/capture" "true"
verify_not_found "LifeOS API duplicate-separator traversal" "//life/api/../capture" "true"
verify_not_found "LifeOS asset dot-prefix traversal" "/./life/assets/../capture" "true"
verify_not_found "Root API encoded-separator prefix traversal" "/%2F%61pi/%2e%2e/settings" "true"
verify_not_found "Root asset literal-separator prefix traversal" "//assets/../settings" "true"
verify_not_found "Root asset dot-component prefix traversal" "/./%2E/%61ssets/%2e%2E/settings" "true"
verify_not_found "LifeOS API encoded-separator prefix traversal" "/%2Flife/%61pi/%2e%2e/capture" "true"
verify_not_found "LifeOS asset literal-separator prefix traversal" "//%6Cife/assets/../capture" "true"
verify_not_found "LifeOS API dot-component prefix traversal" "/./life/%2E/%61pi/%2e%2e/capture" "true"
verify_not_found "LifeOS asset mixed normalization prefix traversal" "/%2E/%6cife/%2F%61ssets/%2e%2E/capture" "true"
verify_not_found "Root API cancelled-prefix traversal" "/foo/../api/../settings" "true"
verify_not_found "Root API encoded cancelled-prefix traversal" "/%66oo/%2e%2e/%61pi/%2e%2e/settings" "true"
verify_not_found "Root API duplicate-separator cancelled-prefix traversal" "//foo/../api/../settings" "true"
verify_not_found "Root API encoded-separator cancelled-prefix traversal" "/%2Ffoo/%2e%2e/api/%2e%2e/settings" "true"
verify_not_found "LifeOS asset cancelled-prefix traversal" "/life/foo/../assets/../capture" "true"
verify_not_found "LifeOS asset encoded cancelled-prefix traversal" "/life/%66oo/%2e%2e/%61ssets/%2e%2e/capture" "true"
verify_not_found "Root API nested cancelled-prefix traversal" "/alpha/beta/../../api/v1/../../settings" "true"
verify_not_found "LifeOS asset nested cancelled-prefix traversal" "/life/one/two/../../assets/v1/../../capture" "true"
verify_not_found "Root API traversal" "/api/%2e%2e%2Fsettings" "true"
verify_not_found "Root API adjacent-separator traversal" "/api/%2F%2e%2e%2Fsettings" "true"
verify_not_found "Root asset traversal" "/assets/%2e%2e%2Fsettings" "true"
verify_not_found "Root asset adjacent-separator traversal" "/assets//%2e%2e/settings" "true"
verify_not_found "LifeOS API traversal" "/life/api/%2e%2e%2Fcapture" "true"
verify_not_found "LifeOS API adjacent-separator traversal" "/life/api//%2e%2e/capture" "true"
verify_not_found "LifeOS asset traversal" "/life/assets/%2e%2e%2Fcapture" "true"
verify_not_found "LifeOS asset adjacent-separator traversal" "/life/assets/%2F%2E%2e%2fcapture" "true"
verify_not_found "Root API uppercase-A encoded traversal" "/%41pi/%2e%2e/settings" "true"
verify_not_found "Root API fully uppercase-byte traversal" "/%41%50%49/%2e%2e/settings" "true"
verify_not_found "Root API mixed encoded-byte traversal" "/%61%50i/%2e%2e/settings" "true"
verify_not_found "Root asset uppercase-A encoded traversal" "/%41ssets/../settings" "true"
verify_not_found "Root asset fully uppercase-byte traversal" "/%41%53%53%45%54%53/%2e%2e/settings" "true"
verify_not_found "Root asset mixed encoded-byte traversal" "/%61%53s%65%54%73/%2e%2e/settings" "true"
verify_not_found "LifeOS asset uppercase-A encoded traversal" "/life/%41ssets/../capture" "true"
verify_not_found "LifeOS asset mixed encoded-byte traversal" "/life/%41%73%53e%54%73/%2e%2e/capture" "true"
verify_json_status "Handler API health" "/api/healthz"
verify_json_status "Brain API health" "/api/brain/health"
verify_json_status "LifeOS API health" "/life/api/healthz"
