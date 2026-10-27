#!/usr/bin/env python3
"""Regenerate docs/ops/stage63-repo-map-golden.json (Stage 63, docs:bounded-map-artifact).

Independent oracle for the bounded repository map: tools/repo_map.py is loaded
straight from the pinned Standard commit (reusing the S5 generator's loader)
and replayed twice.

1. With its frozen plane patterns: plane_for, build (including every refusal
   and its message) and validate_edit, so the JS port reproduces the contract.
2. Rebound to hyperbolic-core's plane patterns from docs/ops/repo-map-source.json:
   upstream build() computes the map from the same source the JS generator
   reads, and the exact expected docs/repo-map.json text is recorded. The
   committed artifact must equal it byte for byte.

    python3 docs/ops/stage63-repo-map-golden.py <agent-engineering-standard checkout> \
        > docs/ops/stage63-repo-map-golden.json
"""

import copy
import importlib.util
import json
import pathlib
import sys

sys.dont_write_bytecode = True  # loading the S5 generator must not litter docs/ops/__pycache__
_SPEC = importlib.util.spec_from_file_location(
    "stage63_continuity_golden",
    pathlib.Path(__file__).with_name("stage63-continuity-golden.py"))
_S5 = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_S5)
SHA = _S5.SHA
SOURCE = pathlib.Path(__file__).with_name("repo-map-source.json")
BINDINGS = {"generated": "GENERATED_PATTERNS", "artifact": "ARTIFACT_PATTERNS",
            "cache": "CACHE_PATTERNS", "evidence": "EVIDENCE_PATTERNS",
            "protected": "PROTECTED_PATTERNS"}


def outcome(call):
    """Run one upstream call; an exception becomes its type name and message."""
    try:
        return {"value": call()}
    except Exception as error:  # noqa: BLE001 - the type and message are the oracle
        return {"error": type(error).__name__, "message": str(error)}


def entry(path, reason="r", plane=None):
    out = {"path": path, "reason": reason}
    if plane is not None:
        out["plane"] = plane
    return out


PLANE_PATHS = (
    "", "README.md", "tools/x.py", "main", "main.py", "maintenance.md", "domain/main.py",
    ".github/workflows/pr-gate.yml", ".github/workflows/pr-gate.yml.bak",
    ".github/workflows/merge-policy.yml", ".github/workflows/other.yml",
    ".evidence/", ".evidence/cache/x", ".evidence/run.json", "a/.evidence/x",
    ".worktrees/x", "src/.worktrees/x", "pkg/__pycache__/m.pyc", "__pycache__/m.pyc",
    "Canonical/schemas/a.json", "Canonical/capabilities.json", "Canonical/capabilities.json.bak",
    "Canonical/v4.2-preservation.csv", "Canonical/generated/x.md", "Canonical/generated",
    "canonical/generated/x.md", "Canonical/corpus/x.json", "é/main", "main/é",
)

BUILD_CASES = (
    ("empty", []),
    ("one", [entry("a.py")]),
    ("sorted-by-code-point", [entry("b"), entry("B"), entry("a"), entry("é"), entry("e"),
                              entry("Z")]),
    ("planes-assigned", [entry("Canonical/generated/x"), entry("Canonical/schemas/s"),
                         entry(".worktrees/w"), entry(".evidence/e"),
                         entry(".github/workflows/pr-gate.yml"), entry("tools/t.py")]),
    ("declared-right", [entry("Canonical/generated/x", plane="generated")]),
    ("declared-wrong", [entry("Canonical/generated/x", plane="source")]),
    ("declared-empty", [entry("tools/t.py", plane="")]),
    ("declared-unknown", [entry("tools/t.py", plane="other")]),
    ("missing-path", [{"reason": "r"}]),
    ("empty-path", [entry("")]),
    ("missing-reason", [{"path": "a"}]),
    ("empty-reason", [entry("a", reason="")]),
    ("blank-reason", [entry("a", reason="   ")]),
    ("unicode-blank-reason", [entry("a", reason="　 ")]),
    ("none-reason", [entry("a", reason=None)]),
    ("zero-reason", [entry("a", reason=0)]),
    ("int-reason", [entry("a", reason=7)]),
    ("duplicate", [entry("a"), entry("b"), entry("a")]),
    ("duplicate-after-bad-reason", [entry("a"), entry("a", reason="")]),
    ("budget-exact", [entry("p%02d" % i) for i in range(60)]),
    ("budget-over", [entry("p%02d" % i) for i in range(61)]),
    ("path-int", [entry(5)]),
    ("path-list", [entry(["x"])]),
    ("path-empty-list", [entry([])]),
    ("entry-not-mapping", ["a.py"]),
    ("extra-keys-kept", [{"path": "a", "reason": "r", "owner": "x"}]),
)

EDIT_CASES = (("x", "generated"), ("x", "source"), ("x", "artifact"), ("x", "protected"),
              ("x", ""), ("Canonical/generated/a.md", "generated"))


def frozen_cases(rm):
    return {
        "plane_for": [{"path": p, "plane": rm.plane_for(p)} for p in PLANE_PATHS],
        "build": [{"id": label, "input": copy.deepcopy(entries),
                   "output": outcome(lambda e=copy.deepcopy(entries): rm.build(e))}
                  for label, entries in BUILD_CASES],
        "validate_edit": [{"path": p, "plane": plane, "output": rm.validate_edit(p, plane)}
                          for p, plane in EDIT_CASES],
        "constants": {"PLANES": list(rm.PLANES), "MAP_BUDGET_ENTRIES": rm.MAP_BUDGET_ENTRIES,
                      "GENERATED_PATTERNS": list(rm.GENERATED_PATTERNS),
                      "ARTIFACT_PATTERNS": list(rm.ARTIFACT_PATTERNS),
                      "CACHE_PATTERNS": list(rm.CACHE_PATTERNS),
                      "EVIDENCE_PATTERNS": list(rm.EVIDENCE_PATTERNS),
                      "PROTECTED_PATTERNS": list(rm.PROTECTED_PATTERNS)},
    }


def hyp_cases(rm, source):
    for plane, name in BINDINGS.items():
        setattr(rm, name, tuple(source["patterns"][plane]))
    built = rm.build(copy.deepcopy(source["entries"]))
    probes = sorted({e["path"] for e in source["entries"]} | {
        "apps/shell/node_modules/x/index.js", ".claude/worktrees/w/AGENTS.md",
        "services/brain/__pycache__/m.pyc", ".evidence/run.json", "package-lock.json",
        ".github/workflows/pr-verify.yml", ".github/workflows/ci.yml", "main.py", "maintenance.md",
        "docs/repo-map.json"})
    return {
        "patterns": source["patterns"],
        "plane_for": [{"path": p, "plane": rm.plane_for(p)} for p in probes],
        "map": built,
        "artifact_text": json.dumps(built, indent=2) + "\n",
    }


def main():
    checkout = sys.argv[1]
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    golden = {
        "_provenance": "agent-engineering-standard @ %s: tools/repo_map.py" % SHA,
        "_generator": "docs/ops/stage63-repo-map-golden.py",
        "_python": "%d.%d" % sys.version_info[:2],
        "frozen": frozen_cases(_S5.load(checkout, "repo_map")),
        "hyp": hyp_cases(_S5.load(checkout, "repo_map"), source),
    }
    sys.stdout.write(json.dumps(golden, sort_keys=True, ensure_ascii=True, indent=1) + "\n")


if __name__ == "__main__":
    main()
