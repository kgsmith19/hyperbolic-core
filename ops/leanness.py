"""Per-app leanness record (#450, Phase 6, AC8).

For every app under apps/ this counts tracked files and lines, lists the
largest files, flags oversized files (over OVERSIZED lines), counts declared
dependencies, and flags duplicate config (more than one lockfile or
manifest of the same kind). Every finding carries the decision recorded in
DECISIONS; a finding without one is reported as "undecided" and fails --check.

Usage:
  python3 ops/leanness.py            # print the record
  python3 ops/leanness.py --write    # rewrite docs/planning/leanness.md
  python3 ops/leanness.py --check    # exit 1 if the committed record is stale or undecided
"""

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECORD = ROOT / "docs" / "planning" / "leanness.md"
OVERSIZED = 800
SOURCE = re.compile(r"\.(py|mjs|js|ts|tsx|jsx|css|html|sql|sh)$")
DUP_KINDS = ("package-lock.json", "uv.lock", "pyproject.toml", "tsconfig.json")

# Decision per finding key ("<app>:<kind>:<path>"). Owner stand-in decisions,
# 2026-11-03; revisit when the file changes materially.
DECISIONS = {
    'agentic-command-center:oversized:apps/agentic-command-center/backend/gui/server.test.mjs': 'Keep: one test file per unit under test; splitting moves assertions without adding coverage.',
    'agentic-command-center:oversized:apps/agentic-command-center/backend/runner/runner.test.mjs': 'Keep: one test file per unit under test; splitting moves assertions without adding coverage.',
    'agentic-command-center:oversized:apps/agentic-command-center/backend/hooks/lane.test.mjs': 'Keep: one test file per unit under test; splitting moves assertions without adding coverage.',
    'agentic-command-center:oversized:apps/agentic-command-center/backend/gui/server.mjs': 'Deferred: split along its existing seams with the next behavior change in this file; a standalone split is churn with no test gain.',
    'agentic-command-center:duplicate-config:package-lock.json': 'Keep: the backend root and frontend/ are two separate npm projects outside the root workspaces; ACC Linux and ACC Windows install each.',
    'lifeos:oversized:apps/lifeos/frontend/src/api/types.gen.ts': 'Keep: generated from the backend OpenAPI schema; never edited by hand.',
    'lifeos:oversized:apps/lifeos/backend/src/domains/bills/dispute.py': 'Deferred: split along its existing seams with the next behavior change in this file; a standalone split is churn with no test gain.',
    'lifeos:oversized:apps/lifeos/backend/src/domains/bills/verify.py': 'Deferred: split along its existing seams with the next behavior change in this file; a standalone split is churn with no test gain.',
    'lifeos:oversized:apps/lifeos/backend/tests/bills/test_verification.py': 'Keep: one test file per unit under test; splitting moves assertions without adding coverage.',
    'lifeos:oversized:apps/lifeos/backend/tests/bills/test_dispute.py': 'Keep: one test file per unit under test; splitting moves assertions without adding coverage.',
}


def tracked(root):
    out = subprocess.run(["git", "-C", str(root), "ls-files", "apps"], check=True,
                         capture_output=True, text=True).stdout
    return [line for line in out.splitlines() if line]


def line_count(path):
    try:
        return sum(1 for _ in path.open(encoding="utf-8"))
    except (UnicodeDecodeError, OSError):
        return 0


def dependencies(app_dir):
    count = 0
    for manifest in app_dir.rglob("package.json"):
        if "node_modules" in manifest.parts:
            continue
        data = json.loads(manifest.read_text())
        count += len(data.get("dependencies", {})) + len(data.get("devDependencies", {}))
    for manifest in app_dir.rglob("pyproject.toml"):
        text = manifest.read_text()
        block = re.search(r"^dependencies\s*=\s*\[(.*?)\]", text, re.S | re.M)
        count += len(re.findall(r'"[^"]+"', block.group(1))) if block else 0
    return count


def analyse(root=ROOT):
    root = Path(root)
    apps = {}
    for name in tracked(root):
        parts = name.split("/")
        if len(parts) < 3:
            continue
        apps.setdefault(parts[1], []).append(name)
    report = []
    for app, files in sorted(apps.items()):
        sizes = {f: line_count(root / f) for f in files if SOURCE.search(f)}
        findings = [("oversized", f, n) for f, n in sorted(sizes.items(), key=lambda kv: -kv[1])
                    if n > OVERSIZED]
        kinds = Counter(Path(f).name for f in files if Path(f).name in DUP_KINDS)
        findings += [("duplicate-config", kind, count) for kind, count in sorted(kinds.items()) if count > 1]
        report.append({
            "app": app,
            "files": len(files),
            "source_lines": sum(sizes.values()),
            "dependencies": dependencies(root / "apps" / app),
            "largest": sorted(sizes.items(), key=lambda kv: -kv[1])[:3],
            "findings": [{"key": f"{app}:{kind}:{what}", "kind": kind, "what": what, "measure": n,
                          "decision": DECISIONS.get(f"{app}:{kind}:{what}", "undecided")}
                         for kind, what, n in findings],
        })
    return report


def render(report):
    lines = [
        "# Leanness record (#450, Phase 6)",
        "",
        "Generated by `python3 ops/leanness.py --write`; `--check` fails when this file is stale or a",
        f"finding has no decision. Oversized means a source file over {OVERSIZED} lines. Duplicate config",
        "means more than one lockfile or manifest of the same kind inside one app.",
        "",
        "| App | Tracked files | Source lines | Declared dependencies | Largest source files |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for app in report:
        largest = "; ".join(f"`{Path(f).relative_to('apps/' + app['app'])}` ({n})" for f, n in app["largest"])
        lines.append(f"| {app['app']} | {app['files']} | {app['source_lines']} | {app['dependencies']} | {largest} |")
    lines += ["", "## Findings and decisions", ""]
    rows = [f for app in report for f in app["findings"]]
    if not rows:
        lines.append("No finding.")
    else:
        lines += ["| Finding | Measure | Decision |", "| --- | ---: | --- |"]
        lines += [f"| `{f['key']}` | {f['measure']} | {f['decision']} |" for f in rows]
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    report = analyse()
    text = render(report)
    if args.write:
        RECORD.write_text(text)
        return 0
    if args.check:
        undecided = [f["key"] for app in report for f in app["findings"] if f["decision"] == "undecided"]
        stale = not RECORD.exists() or RECORD.read_text() != text
        for key in undecided:
            print(f"undecided leanness finding: {key}", file=sys.stderr)
        if stale:
            print("docs/planning/leanness.md is stale: run python3 ops/leanness.py --write", file=sys.stderr)
        return 1 if undecided or stale else 0
    print(text, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
