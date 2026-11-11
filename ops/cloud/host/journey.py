"""The owner's user journey against the live edge (#562).

Reads the owner email and password on stdin (ops/cloud/remote.sh smoke pipes
them from Infisical; they are never printed or written). Exercises what a
browser does, through http://127.0.0.1:8080 (the same Caddy that cloudflared
serves): sign in, owner check, registry read, a LifeOS write and read-back,
and Brain's authenticated API plus its provider (a one-line claude call with
the Brain's own key, inside the brain container). Exits non-zero on any failure.
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

EDGE = os.environ.get("EDGE_URL", "http://127.0.0.1:8080")
email, password = (line.strip() for line in sys.stdin.read().splitlines()[:2])
anon = next(
    line.split("=", 1)[1].strip()
    for line in open(os.environ.get("HYP_ENV", "/srv/hyperbolic-core/env") + "/build.env")
    if line.startswith("PLATFORM_ANON_KEY=")
)
failures = []


def call(method, path, body=None, token=None, raw=False):
    headers = {"apikey": anon, "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(EDGE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as res:
        text = res.read().decode()
        return text if raw else (json.loads(text) if text else None)


def step(name, fn):
    try:
        detail = fn()
        print(f"ok   {name}" + (f": {detail}" if detail else ""))
    except Exception as err:  # noqa: BLE001 - report every failing step
        msg = err.read().decode()[:200] if isinstance(err, urllib.error.HTTPError) else str(err)[:200]
        print(f"FAIL {name}: {msg}")
        failures.append(name)


session = {}


def sign_in():
    tok = call("POST", "/platform/auth/v1/token?grant_type=password", {"email": email, "password": password})
    session["token"] = tok["access_token"]
    return "access token issued"


step("platform sign-in (owner)", sign_in)
token = session.get("token")
step("platform owner check", lambda: str(call("POST", "/platform/rest/v1/rpc/is_platform_owner", {}, token)))
step("tool registry read", lambda: f"{len(call('GET', '/platform/rest/v1/app?select=*', token=token))} apps")


def lifeos_unauth():
    try:
        call("GET", "/life/api/types")
    except urllib.error.HTTPError as err:
        assert err.code == 401, err.code
        return "401"
    raise AssertionError("LifeOS answered without a token")


def lifeos_roundtrip():
    types = {t["name"] for t in call("GET", "/life/api/types", token=token)}
    if "deploy_probe" not in types:
        call("POST", "/life/api/types", {"name": "deploy_probe", "domain": "ops", "json_schema": {
            "type": "object", "x-identity": ["probe"],
            "properties": {"probe": {"type": "string"}, "at": {"type": "string"}}}}, token)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    result = call("POST", "/life/api/capture", {"type_name": "deploy_probe",
                                                "attributes": {"probe": "smoke", "at": stamp}}, token)
    entity = call("GET", f"/life/api/entities/{result['entity_id']}", token=token)
    assert stamp in json.dumps(entity), "read-back does not carry the write"
    return f"entity {result['entity_id']} written and read back"


step("LifeOS anonymous request refused", lifeos_unauth)
step("LifeOS write + read-back (owner JWT via JWKS)", lifeos_roundtrip)
step("Brain health", lambda: call("GET", "/api/brain/health")["status"])
step("Brain authenticated API (cost)", lambda: "ok" if call("GET", "/api/brain/cost", token=token) is not None else "")


def brain_provider():
    base = ["docker", "compose", "-p", "hyperbolic-core", "exec", "-T", "brain"]
    iso = subprocess.run(base + ["node", "services/brain/scripts/isolation-check.mjs"], capture_output=True, text=True)
    assert iso.returncode == 0, "brain cannot read its own key file"
    other = subprocess.run(["docker", "compose", "-p", "hyperbolic-core", "exec", "-T", "platform-api", "node",
                            "-e", "require('fs').readFileSync('/run/secrets/brain/anthropic-api-key')"],
                           capture_output=True, text=True)
    assert other.returncode != 0, "another container can read the Brain key"
    probe = subprocess.run(base + ["sh", "-c", 'ANTHROPIC_API_KEY="$(cat /run/secrets/brain/anthropic-api-key)" '
                                   'claude -p "Reply with exactly: BRAIN-OK" --max-turns 1'],
                           capture_output=True, text=True, timeout=180)
    assert "BRAIN-OK" in probe.stdout, (probe.stdout + probe.stderr)[-200:]
    return "key isolated to brain; claude CLI answered via the Brain's key"


step("Brain provider (ADR-05 isolation + live model call)", brain_provider)

print("journey: " + ("ok" if not failures else f"FAILED: {', '.join(failures)}"))
sys.exit(1 if failures else 0)
