#!/usr/bin/env python3
"""Regenerate docs/ops/stage63-quality-golden.json (Stage 63 S4, #422).

Independent oracle for the S4 implementation-quality ports in
stage63-adoption-lib.mjs: quality_eval.rank is computed by the upstream Python
module, loaded straight from the pinned Standard commit (never from a working
tree), reusing the S5 generator's loader (stage63-continuity-golden.py).

    /usr/bin/python3.12 docs/ops/stage63-quality-golden.py <agent-engineering-standard checkout> \
        > docs/ops/stage63-quality-golden.json

Solution ids are chosen to pin Python's code-point tie-break: a locale or
UTF-16 comparison orders "a"/"B", "é"/"f" and U+1F600/U+FFFF differently.
"""

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
MODULES = ("quality_eval",)


def conforming(solution_id, owned_loc=100):
    return {"id": solution_id, "correct": True, "charter_clean": True, "quality_ok": True,
            "plane_clean": True, "dependency_ok": True, "owned_loc": owned_loc,
            "reviewers_agree": True}


def incorrect(solution_id, owned_loc=1):
    return dict(conforming(solution_id, owned_loc), correct=False)


RANK_SETS = (
    ("ascii-control", [conforming("alpha"), conforming("zeta")]),
    ("case-same-points", [conforming("a"), conforming("B")]),
    ("case-three-way", [conforming("b"), conforming("B"), conforming("a"), conforming("A")]),
    ("accent-vs-letter", [conforming("é"), conforming("f")]),
    ("accent-vs-capital", [conforming("É"), conforming("f"), conforming("e")]),
    ("astral-vs-fffd", [conforming("\U0001f600"), conforming("￿")]),
    ("astral-vs-bmp", [conforming("\U0001f600"), conforming("z"), conforming("ÿ")]),
    ("incorrect-tie-case", [incorrect("a"), incorrect("B")]),
    ("incorrect-after-winners", [incorrect("a"), conforming("B", 200), conforming("é")]),
    ("owned-loc-before-id", [conforming("a", 150), conforming("B", 100)]),
    ("empty", []),
)


def rank_cases(qe):
    return [{"label": label, "solutions": solutions, "output": qe.rank(solutions)}
            for label, solutions in RANK_SETS]


def render(golden):
    """One case per line (same layout as the other Stage 63 goldens)."""
    def dumps(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    def block(cases):
        return "[\n" + ",\n".join("  " + dumps(case) for case in cases) + "\n ]"

    return ("{\n " + ",\n ".join([
        '"_generator":%s' % dumps(golden["_generator"]),
        '"_provenance":%s' % dumps(golden["_provenance"]),
        '"_python":%s' % dumps(golden["_python"]),
        '"rank":%s' % block(golden["rank"]),
    ]) + "\n}\n")


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    qe = _S5.load(sys.argv[1], "quality_eval")
    golden = {
        "_provenance": "agent-engineering-standard @ %s: tools/quality_eval.py" % SHA,
        "_generator": "docs/ops/stage63-quality-golden.py",
        "_python": "%d.%d" % sys.version_info[:2],
        "rank": rank_cases(qe),
    }
    sys.stdout.write(render(golden))


if __name__ == "__main__":
    main()
