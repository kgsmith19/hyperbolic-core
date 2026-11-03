"""Local release tagging and rollback (#504, AC3).

`tag` runs the health command against the current, clean HEAD. Only a
healthy build gets a `release-<name>` tag at its exact SHA. A failed health
check tags nothing, and records nothing.

`rollback` returns the running release to the previous tagged SHA: it
deploys that SHA, then health-checks it. If the rollback deploy or its health
check fails, the attempt is recorded as `failed-rollback` and the command
exits non-zero, so a broken rollback is never silent.

When `tag` is given a `--deploy`, a health check that fails after that deploy
is an automatic rollback (#504, AC3): the previous live release is redeployed
and health-checked, the rejected build is recorded as `rejected`, and nothing
is tagged. `{sha}` in the deploy command is replaced by the target SHA.

Before a deploy, `--canary` runs the candidate in a separate stack and health
checks it; a failed canary deploys nothing and tags nothing (canary-missing).
After the deploy, three gates must pass before the tag: `--health`,
`--invariant` (for example a backup plus restore drill with SQLite integrity
checks: invariant-breach) and `--telemetry`, whose stdout must be a non-empty
JSON health report for the running services (missing-telemetry). A healthy
build gets a signed attestation (missing-attestation): a manifest binding the
release name, commit SHA, tree SHA and gate results, HMAC-SHA256 signed with a
local key, verified before the tag is written and again by `verify`.

The release history lives in var/releases.json, which is local state and not
committed. Attestations sit beside it in var/attestations/, and the signing
key in var/release-key (mode 0600). Deploy and health are shell commands, so the same mechanism runs
`make up` plus a curl in CI-less local use, and a stub in tests.
"""

import argparse
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def git(repo, *args, check=True):
    return subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True).stdout.strip()


def shell_ok(cmd, cwd):
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True).returncode == 0


def shell_capture(cmd, cwd):
    result = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    return result.returncode, result.stdout


ATTESTATION_SCHEMA = "hyperbolic-core.release-attestation/v1"


def _canonical(payload):
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def signing_key(path):
    """The local release signing key, created once with owner-only permissions."""
    path = Path(path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_hex(32))
    return bytes.fromhex(path.read_text().strip())


def attest(repo, attest_dir, key_path, name, sha, checks):
    payload = {
        "schema": ATTESTATION_SCHEMA,
        "name": name,
        "tag": f"release-{name}",
        "sha": sha,
        "tree": git(repo, "rev-parse", f"{sha}^{{tree}}"),
        "checks": checks,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    signature = hmac.new(signing_key(key_path), _canonical(payload), hashlib.sha256).hexdigest()
    path = Path(attest_dir) / f"release-{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"payload": payload, "hmac_sha256": signature}, indent=2, sort_keys=True) + "\n")
    return path, signature


def verify_attestation(repo, path, key_path, expected_sha=None):
    """Return a list of problems; empty means the attestation is genuine and matches the repo."""
    try:
        doc = json.loads(Path(path).read_text())
        payload, signature = doc["payload"], doc["hmac_sha256"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return [f"unreadable attestation: {exc}"]
    problems = []
    if not Path(key_path).exists():
        return ["no signing key: the attestation cannot be verified"]
    expected = hmac.new(signing_key(key_path), _canonical(payload), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, str(signature)):
        problems.append("signature does not match the payload")
    if payload.get("schema") != ATTESTATION_SCHEMA:
        problems.append("unknown attestation schema")
    sha = payload.get("sha", "")
    if expected_sha and sha != expected_sha:
        problems.append("attested SHA is not the release SHA")
    tree = git(repo, "rev-parse", f"{sha}^{{tree}}", check=False)
    if tree != payload.get("tree"):
        problems.append("attested tree does not match the commit")
    return problems


class ReleaseLog:
    def __init__(self, path):
        self.path = Path(path)

    def read(self):
        if not self.path.exists():
            return {"releases": [], "current": None}
        return json.loads(self.path.read_text())

    def write(self, state):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def _gates(repo, health_cmd, invariant_cmd, telemetry_cmd):
    """Run the post-deploy gates in order. Return (failed_gate_or_None, checks)."""
    checks = {"health": shell_ok(health_cmd, repo)}
    if not checks["health"]:
        return "health check", checks
    if invariant_cmd:
        checks["invariant"] = shell_ok(invariant_cmd, repo)
        if not checks["invariant"]:
            return "invariant check", checks
    if telemetry_cmd:
        code, out = shell_capture(telemetry_cmd, repo)
        try:
            report = json.loads(out) if code == 0 else None
        except ValueError:
            report = None
        if not report:
            checks["telemetry"] = None
            return "telemetry check", checks
        checks["telemetry"] = hashlib.sha256(_canonical(report)).hexdigest()
    return None, checks


def tag(repo, log, name, health_cmd, deploy_cmd=None, *, canary_cmd=None, invariant_cmd=None,
        telemetry_cmd=None, attest_dir=None, key_path=None):
    if git(repo, "status", "--porcelain"):
        raise SystemExit("refusing to tag a dirty tree: commit or stash first")
    sha = git(repo, "rev-parse", "HEAD")
    attest_dir = Path(attest_dir or log.path.parent / "attestations")
    key_path = Path(key_path or log.path.parent / "release-key")
    checks = {}
    if canary_cmd:
        checks["canary"] = shell_ok(canary_cmd.replace("{sha}", sha), repo)
        if not checks["canary"]:
            return 2, f"canary failed for {sha[:12]}; nothing deployed, nothing tagged"
    if deploy_cmd and not shell_ok(deploy_cmd.replace("{sha}", sha), repo):
        return 2, f"deploy failed for {sha[:12]}; nothing tagged"
    failed, gate_checks = _gates(repo, health_cmd, invariant_cmd, telemetry_cmd)
    checks.update(gate_checks)
    if failed:
        if deploy_cmd:
            return _reject_and_roll_back(repo, log, name, sha, deploy_cmd, health_cmd, failed)
        return 2, f"{failed} failed for {sha[:12]}; nothing tagged"
    path, signature = attest(repo, attest_dir, key_path, name, sha, checks)
    problems = verify_attestation(repo, path, key_path, sha)
    if problems:
        path.unlink()
        return 2, f"attestation for {sha[:12]} did not verify ({'; '.join(problems)}); nothing tagged"
    tag_name = f"release-{name}"
    git(repo, "tag", tag_name, sha)
    state = log.read()
    state["releases"].append({"name": name, "tag": tag_name, "sha": sha, "status": "live",
                              "attestation": str(path), "attestation_hmac": signature,
                              "at": datetime.now(timezone.utc).isoformat()})
    state["current"] = name
    log.write(state)
    return 0, f"tagged {tag_name} at {sha}"


def verify(repo, log, name, key_path=None):
    state = log.read()
    entries = [r for r in state["releases"] if r.get("name") == name and r.get("attestation")]
    if not entries:
        return 2, f"no attested release named {name}"
    entry = entries[-1]
    key_path = Path(key_path or log.path.parent / "release-key")
    problems = verify_attestation(repo, entry["attestation"], key_path, entry["sha"])
    tagged = git(repo, "rev-parse", f"{entry['tag']}^{{commit}}", check=False)
    if tagged != entry["sha"]:
        problems.append("the release tag no longer points at the attested SHA")
    if problems:
        return 3, f"attestation for {entry['tag']} is invalid: {'; '.join(problems)}"
    return 0, f"attestation for {entry['tag']} verifies at {entry['sha']}"


def _reject_and_roll_back(repo, log, name, sha, deploy_cmd, health_cmd, failed="health check"):
    """The new build was deployed but failed its health check: put the previous live release back."""
    state = log.read()
    stamp = datetime.now(timezone.utc).isoformat()
    live = [r for r in state["releases"] if r["status"] == "live"]
    state["releases"].append({"name": name, "sha": sha, "status": "rejected", "at": stamp})
    if not live:
        log.write(state)
        return 2, f"{failed} failed after deploy of {sha[:12]}; no previous release to roll back to; nothing tagged"
    previous = live[-1]
    if shell_ok(deploy_cmd.replace("{sha}", previous["sha"]), repo) and shell_ok(health_cmd, repo):
        log.write(state)
        return 2, (f"{failed} failed after deploy of {sha[:12]}; rolled back to "
                   f"{previous['tag']}; nothing tagged")
    state["releases"].append({"name": previous["name"], "tag": previous["tag"], "sha": previous["sha"],
                              "status": "failed-rollback", "at": stamp})
    log.write(state)
    return 3, (f"{failed} failed after deploy of {sha[:12]} and rollback to {previous['tag']} "
               "failed; investigate before retrying")


def rollback(repo, log, deploy_cmd, health_cmd):
    state = log.read()
    live = [r for r in state["releases"] if r["status"] == "live"]
    if len(live) < 2:
        return 2, "no previous tagged release to roll back to"
    current, previous = live[-1], live[-2]
    stamp = datetime.now(timezone.utc).isoformat()
    if not shell_ok(deploy_cmd.replace("{sha}", previous["sha"]), repo) or \
            not shell_ok(health_cmd, repo):
        current["status"] = "rolled-back-failed"
        state["releases"].append({"name": previous["name"], "tag": previous["tag"], "sha": previous["sha"],
                                  "status": "failed-rollback", "at": stamp})
        log.write(state)
        return 3, f"rollback to {previous['tag']} failed; investigate before retrying"
    current["status"] = "rolled-back"
    state["releases"].append({"name": previous["name"], "tag": previous["tag"], "sha": previous["sha"],
                              "status": "live", "at": stamp})
    state["current"] = previous["name"]
    log.write(state)
    return 0, f"rolled back to {previous['tag']} at {previous['sha']}"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--log", default=str(ROOT / "var" / "releases.json"))
    sub = parser.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tag")
    t.add_argument("name")
    t.add_argument("--health", required=True)
    t.add_argument("--deploy", default=None,
                   help="shell command; {sha} is replaced by the target SHA. A failed gate "
                        "after it rolls back automatically")
    t.add_argument("--canary", default=None,
                   help="shell command run before the deploy against a separate canary stack")
    t.add_argument("--invariant", default=None,
                   help="shell command run after the health check, e.g. backup plus restore drill")
    t.add_argument("--telemetry", default=None,
                   help="shell command whose stdout must be a non-empty JSON health report")
    r = sub.add_parser("rollback")
    r.add_argument("--health", required=True)
    r.add_argument("--deploy", required=True, help="shell command; {sha} is replaced by the target SHA")
    v = sub.add_parser("verify")
    v.add_argument("name")
    sub.add_parser("status")
    args = parser.parse_args(argv)
    log = ReleaseLog(args.log)
    if args.cmd == "status":
        print(json.dumps(log.read(), indent=2, sort_keys=True))
        return 0
    if args.cmd == "tag":
        code, message = tag(args.repo, log, args.name, args.health, args.deploy,
                            canary_cmd=args.canary, invariant_cmd=args.invariant,
                            telemetry_cmd=args.telemetry)
    elif args.cmd == "verify":
        code, message = verify(args.repo, log, args.name)
    else:
        code, message = rollback(args.repo, log, args.deploy, args.health)
    print(message)
    return code


if __name__ == "__main__":
    sys.exit(main())
