# Shared operator helpers for ops/cloud/*.sh and infra/cloudflare/cf.sh-style
# access (#562): Infisical machine-identity login and secret get/put. Values
# are passed on stdin/stdout only; nothing secret is echoed.
INFISICAL_API="${INFISICAL_API:-https://app.infisical.com}"
export INFISICAL_API
log() { echo "${0##*/}: $*" >&2; }
die() { log "$*"; exit 1; }

_inf_login() {
  if [[ -n "${INFISICAL_TOKEN:-}" ]]; then echo "$INFISICAL_TOKEN"; return; fi
  [[ -n "${INFISICAL_CLIENT_ID:-}" && -n "${INFISICAL_CLIENT_SECRET:-}" ]] ||
    die "set INFISICAL_TOKEN, or INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET"
  curl -fsS -X POST "$INFISICAL_API/api/v1/auth/universal-auth/login" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,os;print(json.dumps({"clientId":os.environ["INFISICAL_CLIENT_ID"],"clientSecret":os.environ["INFISICAL_CLIENT_SECRET"]}))')" |
    python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])'
}
[[ -n "${INFISICAL_PROJECT_ID:-}" ]] || die "INFISICAL_PROJECT_ID is not set"
export INFISICAL_PROJECT_ID
INF_TOKEN="${INF_TOKEN:-$(_inf_login)}"; export INF_TOKEN

secret_get() {  # <path> <KEY>
  curl -fsS "$INFISICAL_API/api/v3/secrets/raw/$2?workspaceId=$INFISICAL_PROJECT_ID&environment=prod&secretPath=$1" \
    -H "Authorization: Bearer $INF_TOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["secret"]["secretValue"])'
}

secret_put() {  # <path> <KEY>, value on stdin; creates the folder path if needed
  # The program goes in -c, not a heredoc, so stdin stays the secret value.
  python3 -c "$_SECRET_PUT_PY" "$1" "$2"
}

_SECRET_PUT_PY='
import json, os, sys, urllib.error, urllib.request
path, key = sys.argv[1], sys.argv[2]
value = sys.stdin.read().rstrip("\n")
if not value:
    sys.exit(f"refusing to store an empty value for {path}/{key}")
api, tok, proj = os.environ["INFISICAL_API"], os.environ["INF_TOKEN"], os.environ["INFISICAL_PROJECT_ID"]
h = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}
def call(method, url, body):
    urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(body).encode(), headers=h, method=method))
parent = "/"
for part in [p for p in path.split("/") if p]:
    try: call("POST", f"{api}/api/v1/folders", {"workspaceId": proj, "environment": "prod", "name": part, "path": parent})
    except urllib.error.HTTPError: pass
    parent = parent.rstrip("/") + "/" + part
body = {"workspaceId": proj, "environment": "prod", "secretPath": path, "secretValue": value, "type": "shared"}
for method in ("PATCH", "POST"):
    try:
        call(method, f"{api}/api/v3/secrets/raw/{key}", body); print(f"stored {path}/{key}", file=sys.stderr); break
    except urllib.error.HTTPError as err:
        status = err.code
else:
    sys.exit(f"could not store {path}/{key} (HTTP {status})")
'
