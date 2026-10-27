#!/usr/bin/env python3
"""Regenerate docs/ops/stage63-release-golden.json (Stage 63 S10, #428).

Independent oracle for the S10 release/runtime ports in
stage63-release-lib.mjs: release_mold.evaluate, proof_invalidation's
freeze/classify/check, and edition_packaging's contract checks are computed
by the upstream Python modules, loaded straight from the pinned Standard
commit (never from a working tree), reusing the S5 generator's loader.

    python3 docs/ops/stage63-release-golden.py <agent-engineering-standard checkout> \
        > docs/ops/stage63-release-golden.json

Every frozen corpus (release-mold, proof-invalidation, edition-packaging) is
embedded, so the JS replay needs no checkout. Inputs are JSON plain data.
Integral floats are avoided on purpose: JSON cannot tell 2.0 from 2.
"""

import copy
import importlib.util
import json
import pathlib
import subprocess
import sys

sys.dont_write_bytecode = True  # loading the S5 generator must not litter docs/ops/__pycache__
_SPEC = importlib.util.spec_from_file_location(
    "stage63_continuity_golden",
    pathlib.Path(__file__).with_name("stage63-continuity-golden.py"))
_S5 = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_S5)
SHA = _S5.SHA
MODULES = ("release_mold", "proof_invalidation", "edition_packaging")
CORPORA = {
    "release": "Canonical/corpus/release-mold/mold.json",
    "invalidation": "Canonical/corpus/proof-invalidation/invalidation.json",
    "edition": "Canonical/corpus/edition-packaging/edition.json",
}
DROP = object()  # variant() removes a key when given this sentinel


def corpus(checkout, path):
    return json.loads(subprocess.run(
        ["git", "-C", checkout, "show", "%s:%s" % (SHA, path)],
        check=True, capture_output=True, text=True).stdout)


def guarded(call):
    """Run one upstream call; an exception becomes {"error": <type name>}."""
    try:
        return call()
    except Exception as error:  # noqa: BLE001 - the type is the oracle
        return {"error": type(error).__name__}


def variant(base, changes):
    """Deep-copy base and apply changes; DROP removes the key."""
    out = copy.deepcopy(base)
    for key, value in changes.items():
        if value is DROP:
            out.pop(key, None)
        else:
            out[key] = copy.deepcopy(value)
    return out


# --- release_mold -----------------------------------------------------------

def release_result(rm, package):
    decision = rm.evaluate(package)
    return {"verdict": decision.verdict, "rule": decision.rule, "findings": decision.findings}


def release_cases(rm, corpus_doc):
    base = rm.clean_package()
    cases = []

    def add(label, package):
        cases.append({"id": label, "input": package,
                      "output": guarded(lambda: release_result(rm, package))})

    for entry in corpus_doc["entries"]:
        add("corpus:" + entry["id"], entry["package"])
    add("clean", base)
    for key in sorted(k for k, v in base.items() if isinstance(v, bool)):
        add("flip:" + key, variant(base, {key: not base[key]}))
    for value in (0, 1, 2, 5, -1, True, False, "2", "x", 2.5, None, [1], {"a": 1}):
        add("open_blockers=" + json.dumps(value), variant(base, {"open_blockers": value}))
    for value in ("", "   ", "　", "v5 ", "é", 123, True, None, ["x"],
                  {"a": 1}, "x" * 250):
        add("release=" + json.dumps(value), variant(base, {"release": value}))
    for value in ("", None, 0, "1%", ["x"]):
        add("canary_exposure=" + json.dumps(value), variant(base, {"canary_exposure": value}))
    for value in ("", None):
        add("canary_window=" + json.dumps(value), variant(base, {"canary_window": value}))
    invariant_sets = ([], ["a"], ["a", "b"], ["a", "b", "c", "d", "e"],
                      ["a", "b", "c", "d", "e", "f"], ["a", 1, None, True], "abc", None,
                      [["x"], "y", "z"])
    for value in invariant_sets:
        add("canary_invariants=" + json.dumps(value),
            variant(base, {"canary_invariants": value}))
    claim_sets = ([], [c for c in rm.CLAIMS if c != "canary-proof"],
                  list(rm.CLAIMS) + ["extra"], "integrated-behavior", None,
                  ["integrated-behavior", 5, None, True])
    for value in claim_sets:
        add("claims=" + json.dumps(value), variant(base, {"claims": value}))
    for label, package in (
            ("empty", {}), ("none", None), ("list", []), ("text", "x"), ("int", 5),
            ("release-none", {"release": None}),
            ("partial-clean", {"release": "v1", "restore_rpo_ok": True,
                               "restore_rto_ok": True, "claims": list(rm.CLAIMS)}),
            ("rpo-only", variant(base, {"restore_rto_ok": False})),
            ("unbuilt-mold", variant(base, {"mold_built": False})),
            ("canary-undeclared", variant(base, {"canary_declared": False})),
            ("missing-claim", variant(base, {"claims": list(rm.CLAIMS)[:-1]})),
            ("blocker-and-stale", variant(base, {"open_blockers": 2, "artifact_fresh": False}))):
        add("package-" + label, package)
    return cases


def release_validators(rm, corpus_doc):
    cases = []
    good = {"id": "x", "rule": "clean-promote", "finding": "m", "severity": "minor", "excerpt": "e"}
    samples = (
        ("valid", good), ("text", "x"), ("list", []), ("int", 1), ("none", None),
        ("missing-key", {k: v for k, v in good.items() if k != "excerpt"}),
        ("bad-rule", dict(good, rule="made-up")), ("rule-none", dict(good, rule=None)),
        ("bad-severity", dict(good, severity="info")), ("severity-none", dict(good, severity=None)),
        ("empty", {}),
    )
    for label, finding in samples:
        cases.append({"id": "finding:" + label, "input": finding,
                      "output": guarded(lambda f=finding: rm.validate_finding(f))})
    corpus_variants = (
        ("frozen", corpus_doc),
        ("not-frozen", dict(corpus_doc, _frozen=False)),
        ("bad-provenance", dict(corpus_doc, _provenance="Stage 99")),
        ("bare-array", corpus_doc["entries"]),
        ("no-entries", {"_frozen": True, "_provenance": "Stage 61a #152"}),
        ("text", "x"),
        ("short", dict(corpus_doc, entries=corpus_doc["entries"][:3])),
    )
    for label, doc in corpus_variants:
        findings, entries = rm.validate_release_corpus(doc)
        cases.append({"id": "corpus:" + label, "input": doc,
                      "output": {"findings": findings, "entries": len(entries)}})
    return cases


# --- proof_invalidation -----------------------------------------------------

BASE_RUN = {
    "mold": "mold-a", "mold_digest": "a" * 64, "frozen_digest": "a" * 64,
    "frozen_head": "h1", "head": "h2", "intent_digest": "i1", "frozen_intent_digest": "i1",
    "commands": [{"command": "pytest -q", "digest": "d1"}],
    "frozen_commands": [{"command": "pytest -q", "digest": "d1"}],
    "change_class": "editorial", "proof": {}, "prior_approval": {}, "reopen": {},
    "protected_paths": ["tools/core"], "touched_paths": ["docs/readme.md"],
    "provider": "claude",
}


def invalidation_result(pi, run):
    result = pi.check_invalidation(run)
    return {"change_class": result.change_class, "findings": result.findings,
            "invalidated": result.invalidated, "classify": pi.classify_change(run)}


def invalidation_cases(pi, corpus_doc):
    cases = []

    def add(label, run):
        cases.append({"id": label, "input": run,
                      "output": guarded(lambda: invalidation_result(pi, run))})

    for entry in corpus_doc["entries"]:
        add("corpus:" + entry["id"], entry["run"])
    add("base", BASE_RUN)
    mutations = (
        ("payload", {"mold_digest": "b" * 64}),
        ("payload-proof", {"mold_digest": "b" * 64, "proof": {"verdict": "PASS", "run_digest": "r"}}),
        ("payload-proof-list", {"mold_digest": "b" * 64, "proof": {"verdict": ["x"]}}),
        ("payload-proof-none", {"mold_digest": "b" * 64, "proof": {"verdict": None}}),
        ("payload-proof-quote", {"mold_digest": "b" * 64, "proof": {"verdict": "it's"}}),
        ("payload-approval", {"mold_digest": "b" * 64, "prior_approval": {"kind": "release"}}),
        ("payload-approval-default", {"mold_digest": "b" * 64, "prior_approval": {"x": 1}}),
        ("payload-approval-none", {"mold_digest": "b" * 64, "prior_approval": {"kind": None}}),
        ("intent", {"intent_digest": "i2"}),
        ("intent-proof", {"intent_digest": "i2", "proof": {"verdict": "PASS"}}),
        ("command-changed", {"commands": [{"command": "pytest -q", "digest": "d2"}]}),
        ("command-removed", {"commands": []}),
        ("command-added", {"commands": [{"command": "pytest -q", "digest": "d1"},
                                        {"command": "ruff", "digest": "d3"}]}),
        ("command-unnamed", {"commands": [{"digest": "d1"}, {"command": "", "digest": "x"},
                                          {"command": "pytest -q", "digest": "d1"}]}),
        ("command-dup-frozen", {"frozen_commands": [{"command": "pytest -q", "digest": "d1"},
                                                    {"command": "pytest -q", "digest": "d9"}]}),
        ("command-quotes", {"frozen_commands": [{"command": "say 'hi'", "digest": "d1"}],
                            "commands": [{"command": "say 'hi'", "digest": "d1"}]}),
        ("command-not-list", {"commands": "pytest -q"}),
        ("protected-exact", {"touched_paths": ["tools/core"]}),
        ("protected-under", {"touched_paths": ["tools/core/x.py"]}),
        ("protected-trap", {"touched_paths": ["tools/corex/a.py"]}),
        ("protected-leading-slash", {"touched_paths": ["/tools/core/a.py"]}),
        ("protected-backslash", {"touched_paths": ["tools\\core\\a.py"]}),
        ("protected-space", {"touched_paths": [" tools/core/a.py "]}),
        ("protected-trailing-slash", {"protected_paths": ["tools/core/"],
                                      "touched_paths": ["tools/core/a.py"]}),
        ("protected-empty", {"protected_paths": [""], "touched_paths": ["tools/core"]}),
        ("protected-int", {"protected_paths": [7], "touched_paths": ["7/a"]}),
        ("protected-not-list", {"protected_paths": "tools/core", "touched_paths": ["tools/core"]}),
        ("touched-dict", {"touched_paths": [{"path": "tools/core"}]}),
        ("reopen-no-requal", {"reopen": {"reason": "rotate", "requalified": False},
                              "mold_digest": "b" * 64, "proof": {"verdict": "PASS"}}),
        ("reopen-requal", {"reopen": {"reason": "rotate", "requalified": True},
                           "mold_digest": "b" * 64, "proof": {"verdict": "PASS"}}),
        ("reopen-blank", {"reopen": {"reason": "   "}, "mold_digest": "b" * 64}),
        ("reopen-yes", {"reopen": {"reason": "x" * 200, "requalified": "yes"},
                        "mold_digest": "b" * 64, "proof": {"verdict": "PASS"}}),
        ("reopen-zero", {"reopen": {"reason": "x", "requalified": 0}, "proof": {"verdict": "P"}}),
        ("reopen-none-reason", {"reopen": {"reason": None}, "mold_digest": "b" * 64}),
        ("reopen-list-reason", {"reopen": {"reason": []}, "intent_digest": "i9"}),
        ("reopen-no-proof", {"reopen": {"reason": "rotate", "requalified": False},
                             "mold_digest": "b" * 64}),
        ("reopen-approval", {"reopen": {"reason": "rotate"}, "prior_approval": {"kind": "review"}}),
        ("unfrozen", {"frozen_digest": ""}),
        ("unfrozen-proof", {"frozen_digest": "", "proof": {"verdict": "PASS"}}),
        ("unfrozen-payload", {"frozen_digest": "", "mold_digest": "b" * 64}),
        ("unnamed-mold", {"mold": "", "mold_digest": "b" * 64}),
        ("long-mold", {"mold": "m" * 300, "mold_digest": "b" * 64}),
        ("unicode-digest", {"frozen_digest": "é" * 20, "mold_digest": "è" * 20}),
        ("provider-only", {"provider": "other"}),
        ("missing-keys", {"mold": DROP, "frozen_digest": DROP, "mold_digest": DROP}),
    )
    for label, changes in mutations:
        run = variant(BASE_RUN, changes)
        add("mut:" + label, {k: v for k, v in run.items() if v is not DROP})
    for label, run in (("none", None), ("list", []), ("text", "x"), ("empty", {})):
        add("run-" + label, run)
    return cases


def freeze_cases(pi):
    cases = []
    samples = (
        ("basic", ("m", "d" * 64, "h1")),
        ("full", ("m", "d", "h", "i", [{"command": "c", "digest": "x"}], "claude")),
        ("digest-none", ("m", None, "h", "i", None, None)),
        ("commands-text", ("m", "d", "h", "i", "pytest", "p")),
        ("command-digest-int", ("m", "d", "h", "i", [{"command": "c", "digest": 5}], "p")),
    )
    for label, args in samples:
        cases.append({"id": "freeze:" + label, "input": list(args),
                      "output": guarded(lambda a=args: pi.freeze(*a))})
    return cases


def invalidation_validators(pi, corpus_doc):
    cases = []
    good = {"id": "x", "rule": "mold-payload-changed", "finding": "m",
            "severity": "blocker", "excerpt": "e"}
    for label, finding in (("valid", good), ("text", "x"), ("bad-rule", dict(good, rule="z")),
                           ("bad-severity", dict(good, severity="low")),
                           ("missing-key", {"rule": "intent-changed"})):
        cases.append({"id": "finding:" + label, "input": finding,
                      "output": guarded(lambda f=finding: pi.validate_finding(f))})
    for label, doc in (("frozen", corpus_doc),
                       ("not-frozen", dict(corpus_doc, _frozen=False)),
                       ("bad-provenance", dict(corpus_doc, _provenance="Stage 99")),
                       ("bare-array", corpus_doc["entries"]),
                       ("text", "x")):
        findings, entries = pi.validate_invalidation_corpus(doc)
        cases.append({"id": "corpus:" + label, "input": doc,
                      "output": {"findings": findings, "entries": len(entries)}})
    return cases


# --- edition_packaging ------------------------------------------------------

def edition_check(ep, target, record, known=None):
    if target == "full":
        return ep.check_full_completeness(record, known if known is not None else [])
    if target == "lite":
        return ep.check_lite_safety_net(record)
    if target == "review":
        return ep.check_lite_omits_review(record)
    if target == "deferral":
        return ep.check_explicit_deferral(record)
    if target == "receipt":
        return ep.check_verify_receipt(record)
    return ep.check_stale_sha_refusal((record or {}).get("tested"), (record or {}).get("head"))


def edition_cases(ep, corpus_doc):
    cases = []
    for entry in corpus_doc["entries"]:
        cases.append({"id": "corpus:" + entry["id"], "input": entry,
                      "output": guarded(lambda e=entry: edition_check(
                          ep, e.get("target"), e.get("record"), e.get("known")))})
    full = list(ep.LITE_REQUIRED) + list(ep.LITE_FORBIDDEN)
    lite_clean = list(ep.LITE_REQUIRED)
    receipt_ok = {"full": {"result": "pass", "head": "h"}, "lite": {"result": "pass", "head": "h"},
                  "gate": "pass", "head": "h"}
    deferral_ok = {"capability": "c", "owner_approved": True}
    samples = (
        ("full-none", "full", None, ["a", "b"]), ("full-missing", "full", ["a"], ["a", "b"]),
        ("full-known-none", "full", ["a"], None), ("full-all", "full", ["a", "b"], ["a", "b"]),
        ("lite-clean", "lite", lite_clean, None), ("lite-missing", "lite", [], None),
        ("lite-forbidden", "lite", full, None), ("lite-none", "lite", None, None),
        ("review-none", "review", None, None), ("review-clean", "review", {"needs": ["build"]}, None),
        ("review-needs", "review", {"needs": ["llm_review"]}, None),
        ("review-expected", "review", {"expected_jobs": ["x llm_review"]}, None),
        ("review-stub", "review", {"stubs": ["llm_review"]}, None),
        ("review-text-needs", "review", {"needs": "llm_review"}, None),
        ("review-int-job", "review", {"needs": [5, None]}, None),
        ("deferral-none", "deferral", None, None), ("deferral-text", "deferral", "x", None),
        ("deferral-item-list", "deferral", [[1]], None),
        ("deferral-ok", "deferral", [deferral_ok], None),
        ("deferral-no-capability", "deferral", [{"owner_approved": True}], None),
        ("deferral-unapproved", "deferral", [{"capability": "c", "owner_approved": False}], None),
        ("deferral-string-approval", "deferral", [{"capability": "c", "owner_approved": "yes"}],
         None),
        ("receipt-none", "receipt", None, None), ("receipt-clean", "receipt", receipt_ok, None),
        ("receipt-empty", "receipt", {}, None),
        ("receipt-lite-fail", "receipt", dict(receipt_ok, lite={"result": "fail", "head": "h"}),
         None),
        ("receipt-mismatch", "receipt", dict(receipt_ok, lite={"result": "pass", "head": "z"}),
         None),
        ("receipt-gate", "receipt", dict(receipt_ok, gate="fail"), None),
        ("receipt-head", "receipt", dict(receipt_ok, head="other"), None),
        ("receipt-no-full-head", "receipt", dict(receipt_ok, full={"result": "pass"}), None),
        ("stale-equal", "stale", {"tested": "a", "head": "a"}, None),
        ("stale-diff", "stale", {"tested": "a", "head": "b"}, None),
        ("stale-none-vs-text", "stale", {"tested": None, "head": "None"}, None),
        ("stale-int-vs-text", "stale", {"tested": 1, "head": "1"}, None),
        ("stale-none-record", "stale", None, None),
    )
    for label, target, record, known in samples:
        cases.append({"id": "edition:" + label, "input": {"target": target, "record": record,
                                                             "known": known},
                      "output": guarded(lambda t=target, r=record, k=known: edition_check(
                          ep, t, r, k))})
    for label, check in (
            ("lite-required", lambda: list(ep.LITE_REQUIRED)),
            ("lite-off", lambda: list(ep.LITE_OFF))):
        cases.append({"id": "constant:" + label, "input": None, "output": check()})
    return cases


def edition_validators(ep, corpus_doc):
    cases = []
    variants = (
        ("frozen", corpus_doc),
        ("not-frozen", dict(corpus_doc, _frozen=False)),
        ("entries-text", dict(corpus_doc, entries="x")),
        ("text", "x"),
        ("entry-text", dict(corpus_doc, entries=["x"])),
        ("unknown-target", dict(corpus_doc, entries=[{"id": "u", "target": "nope",
                                                       "record": None}])),
        ("fragment-miss", dict(corpus_doc, entries=[{"id": "f", "target": "lite", "record": [],
                                                      "expected_violation_fragment": "zzz"}])),
        ("unexpected-violation", dict(corpus_doc, entries=[{"id": "g", "target": "lite",
                                                             "record": []}])),
    )
    for label, doc in variants:
        findings, entries = ep.validate_edition_corpus(doc)
        cases.append({"id": "corpus:" + label, "input": doc,
                      "output": {"findings": findings, "entries": len(entries)}})
    return cases


# --- render -----------------------------------------------------------------

def render(golden):
    def dumps(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))

    lines = []
    for key in sorted(golden):
        value = golden[key]
        if isinstance(value, list):
            body = ",\n".join("  " + dumps(case) for case in value)
            lines.append('"%s":[\n%s\n ]' % (key, body))
        else:
            lines.append('"%s":%s' % (key, dumps(value)))
    return "{\n " + ",\n ".join(lines) + "\n}\n"


def main():
    checkout = sys.argv[1]
    rm = _S5.load(checkout, "release_mold")
    pi = _S5.load(checkout, "proof_invalidation")
    ep = _S5.load(checkout, "edition_packaging")
    release_doc = corpus(checkout, CORPORA["release"])
    invalidation_doc = corpus(checkout, CORPORA["invalidation"])
    edition_doc = corpus(checkout, CORPORA["edition"])
    golden = {
        "_provenance": "agent-engineering-standard @ %s: tools/%s.py + %s" % (
            SHA, ".py + tools/".join(MODULES), " + ".join(sorted(CORPORA.values()))),
        "_generator": "docs/ops/stage63-release-golden.py",
        "_python": "%d.%d" % sys.version_info[:2],
        "release": release_cases(rm, release_doc),
        "release_validators": release_validators(rm, release_doc),
        "invalidation": invalidation_cases(pi, invalidation_doc) + freeze_cases(pi),
        "invalidation_validators": invalidation_validators(pi, invalidation_doc),
        "edition": edition_cases(ep, edition_doc),
        "edition_validators": edition_validators(ep, edition_doc),
    }
    sys.stdout.write(render(golden))


if __name__ == "__main__":
    main()
