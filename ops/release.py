"""Local release tagging and rollback (#504, AC3).

`tag` runs the health command against the current, clean HEAD. Only a
healthy build gets a `release-<name>` tag at its exact SHA. A failed health
check tags nothing, and records nothing.

`rollback` returns the running release to the previous tagged SHA: it
deploys that SHA, then health-checks it. If the rollback deploy or its health
check fails, the attempt is recorded as `failed-rollback` and the command
exits non-zero, so a broken rollback is never silent.

The release history lives in var/releases.json, which is local state and not
committed. Deploy and health are shell commands, so the same mechanism runs
`make up` plus a curl in CI-less local use, and a stub in tests.
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def git(repo, *args, check=True):
    return subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True).stdout.strip()


def shell_ok(cmd, cwd):
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True).returncode == 0


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


def tag(repo, log, name, health_cmd, deploy_cmd=None):
    if git(repo, "status", "--porcelain"):
        raise SystemExit("refusing to tag a dirty tree: commit or stash first")
    sha = git(repo, "rev-parse", "HEAD")
    if deploy_cmd and not shell_ok(deploy_cmd, repo):
        return 2, f"deploy failed for {sha[:12]}; nothing tagged"
    if not shell_ok(health_cmd, repo):
        return 2, f"health check failed for {sha[:12]}; nothing tagged"
    tag_name = f"release-{name}"
    git(repo, "tag", tag_name, sha)
    state = log.read()
    state["releases"].append({"name": name, "tag": tag_name, "sha": sha, "status": "live",
                              "at": datetime.now(timezone.utc).isoformat()})
    state["current"] = name
    log.write(state)
    return 0, f"tagged {tag_name} at {sha}"


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
    t.add_argument("--deploy", default=None)
    r = sub.add_parser("rollback")
    r.add_argument("--health", required=True)
    r.add_argument("--deploy", required=True, help="shell command; {sha} is replaced by the target SHA")
    sub.add_parser("status")
    args = parser.parse_args(argv)
    log = ReleaseLog(args.log)
    if args.cmd == "status":
        print(json.dumps(log.read(), indent=2, sort_keys=True))
        return 0
    if args.cmd == "tag":
        code, message = tag(args.repo, log, args.name, args.health, args.deploy)
    else:
        code, message = rollback(args.repo, log, args.deploy, args.health)
    print(message)
    return code


if __name__ == "__main__":
    sys.exit(main())
