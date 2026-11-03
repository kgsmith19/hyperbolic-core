"""Local release telemetry (#504, missing-telemetry).

Prints one JSON health report for every service declared in compose.yaml, read
from `docker compose ps`. It exits non-zero, with no report, when a declared
service is missing, not running, or not healthy, so `ops/release.py tag
--telemetry` fails closed instead of tagging a release nobody observed.

Usage: python3 ops/telemetry.py [--project NAME]
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone


def _compose(project, *args):
    cmd = ["docker", "compose"] + (["-p", project] if project else []) + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])} failed: {result.stderr.strip()[:200]}")
    return result.stdout


def parse_ps(text):
    """`docker compose ps --format json` prints either one array or one object per line."""
    text = text.strip()
    if not text:
        return []
    if text.startswith("["):
        return json.loads(text)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def report(declared, rows):
    """Return (ok, report). Every declared service must be running and healthy."""
    by_service = {row.get("Service"): row for row in rows}
    services, problems = {}, []
    for name in declared:
        row = by_service.get(name)
        if row is None:
            problems.append(f"{name}: not running")
            continue
        state = row.get("State", "")
        health = row.get("Health", "") or "none"
        services[name] = {"state": state, "health": health}
        if state != "running":
            problems.append(f"{name}: state {state}")
        elif health != "healthy":
            problems.append(f"{name}: health {health}")
    ok = bool(declared) and not problems
    return ok, {
        "schema": "hyperbolic-core.telemetry/v1",
        "at": datetime.now(timezone.utc).isoformat(),
        "services": services,
        "problems": problems,
    }


def main(argv=None, compose=_compose):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", default=None)
    args = parser.parse_args(argv)
    try:
        declared = compose(args.project, "config", "--services").split()
        rows = parse_ps(compose(args.project, "ps", "--all", "--format", "json"))
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"telemetry unavailable: {exc}", file=sys.stderr)
        return 2
    ok, body = report(declared, rows)
    if not ok:
        print("; ".join(body["problems"]) or "no declared services", file=sys.stderr)
        return 1
    print(json.dumps(body, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
