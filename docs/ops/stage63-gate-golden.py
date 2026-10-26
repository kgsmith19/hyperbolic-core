#!/usr/bin/env python3
"""Regenerate docs/ops/stage63-gate-golden.json (Stage 63 S9, #427).

Independent oracle for the S9 Gate/evidence ports in stage63-adoption-lib.mjs:
every case is computed by the upstream Python modules loaded straight from the
pinned Standard commit, reusing the S5 generator's loader
(stage63-continuity-golden.py).

    python3 docs/ops/stage63-gate-golden.py <agent-engineering-standard checkout> \
        > docs/ops/stage63-gate-golden.json

Four upstream surfaces are characterized:
- tools/gate_compliance.py (Stage 57: the read-only Standards Compliance lane
  that reports PASS / FAIL to the single final aggregator);
- tools/tracker_pipeline_gate.py (T05: the tracker, pipeline and gate
  contracts; GitHub YAML is the authoritative rendering);
- tools/completion_receipts.py (T20: MERGED / CLEANED / excluded close
  receipts);
- standardctl.owner_label_authorized, the function the merge-policy contract
  requires hyperbolic-core's PR Gate to mirror exactly.

Besides the hand-built cases, the golden embeds the three frozen upstream
corpora with the upstream violations for every entry. Each owner-label case is
tagged "github" when it is a timeline shape GitHub's API can actually return,
or "malformed" when it only probes plain-data truthiness.

Every input is canonicalized through a sorted-keys JSON round trip before the
upstream call, so Python iterates each mapping in the same key order the JS
replay reads it from this file. Integral floats are avoided on purpose: JSON
cannot tell 2.0 from 2. The file is written with ensure_ascii=True.
"""

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
MODULES = ("gate_compliance", "tracker_pipeline_gate", "completion_receipts", "standardctl")
CORPORA = {
    "lane": "Canonical/corpus/gate-compliance/lane.json",
    "rendering": "Canonical/corpus/tracker-pipeline-gate/rendering.json",
    "receipts": "Canonical/corpus/completion-receipts/receipts.json",
}


def corpus(checkout, path):
    return json.loads(subprocess.run(
        ["git", "-C", checkout, "show", "%s:%s" % (SHA, path)],
        check=True, capture_output=True, text=True).stdout)


def canonical(value):
    """The value as the JS replay reads it back: sorted keys, JSON types."""
    return json.loads(json.dumps(value, sort_keys=True))


def guarded(call):
    """Run one upstream call; an exception becomes {"error": <type name>}."""
    try:
        return call()
    except Exception as error:  # noqa: BLE001 - the type is the oracle
        return {"error": type(error).__name__}


def cases_of(call, labelled, field):
    """[{label, <field>: input, result}] with canonical inputs."""
    return [{"label": label, field: canonical(value),
             "result": guarded(lambda v=value: call(canonical(v)))}
            for label, value in labelled]


def lane_result(decision):
    return {"verdict": decision.verdict, "rule": decision.rule, "findings": decision.findings}


def lane_cases(gc):
    clean = gc.clean_observation()

    def with_(**changes):
        out = dict(clean)
        out.update(changes)
        return out

    def without(*keys, **changes):
        out = with_(**changes)
        for key in keys:
            out.pop(key)
        return out

    moved = "b" * 40
    observations = [
        ("clean", clean),
        ("not-a-mapping-null", None),
        ("not-a-mapping-list", [clean]),
        ("not-a-mapping-string", "PASS"),
        ("empty-mapping", {}),
        ("missing-receipt", with_(receipt_present=False)),
        ("missing-receipt-beats-stale-route", with_(receipt_present=False, route_fresh=False)),
        ("missing-receipt-needs-green-tests", with_(receipt_present=False, tests_green=False)),
        ("missing-receipt-truthy-string-tests", with_(receipt_present=False, tests_green="no")),
        ("stale-route", with_(route_fresh=False)),
        ("stale-route-explicit-null", with_(route_fresh=None)),
        ("stale-route-beats-adapter", with_(route_fresh=False, adapter_healthy=False)),
        ("adapter-degraded", with_(adapter_healthy=False)),
        ("adapter-degraded-zero", with_(adapter_healthy=0)),
        ("adapter-beats-mold", with_(adapter_healthy=False, mold_authorized=False)),
        ("mold-violation", with_(mold_authorized=False)),
        ("mold-beats-self-certify", with_(mold_authorized=False, policy_pr=True, self_certified=True)),
        ("self-certify", with_(policy_pr=True, self_certified=True)),
        ("policy-pr-alone-passes", with_(policy_pr=True)),
        ("self-certified-alone-passes", with_(self_certified=True)),
        ("self-certify-beats-compact", with_(policy_pr=True, self_certified=True, risk="R1")),
        ("compact-r0", with_(risk="R0")),
        ("compact-r1", with_(risk="R1")),
        ("compact-risk-absent", without("risk")),
        ("compact-risk-null", with_(risk=None)),
        ("risk-lowercase-is-not-low", with_(risk="r1")),
        ("risk-padded-is-not-low", with_(risk="R1 ")),
        ("compact-needs-a-valid-receipt", with_(risk="R1", receipt_valid=False)),
        ("compact-r1-lane-absent-passes", with_(risk="R1", lane_present=False)),
        ("compact-r0-head-moved-passes", with_(risk="R0", live_head=moved)),
        ("compact-risk-absent-lane-absent-passes", without("risk", lane_present=False)),
        ("lane-skipped", with_(lane_present=False)),
        ("lane-skipped-r3", with_(lane_present=False, risk="R3")),
        ("lane-skipped-beats-head-moved", with_(lane_present=False, live_head=moved)),
        ("head-moved", with_(live_head=moved)),
        ("head-moved-evidence-empty-is-not-checked", with_(evidence_head="", live_head=moved)),
        ("head-moved-live-null-is-not-checked", with_(live_head=None)),
        ("receipt-invalid-r2", with_(receipt_valid=False)),
        ("receipt-absent-tests-red-r2", with_(receipt_present=False, tests_green=False)),
        ("receipt-absent-tests-red-r1", with_(receipt_present=False, tests_green=False, risk="R1")),
        ("excerpt-pr-null-renders-None", with_(pr=None)),
        ("excerpt-pr-empty-falls-to-profile", with_(pr="")),
        ("excerpt-pr-whitespace-falls-to-profile", with_(pr=" \x85 ")),
        ("excerpt-pr-and-profile-empty", with_(pr="", profile="")),
        ("excerpt-profile-null", with_(pr="", profile=None, receipt_present=False)),
        ("excerpt-pr-number", with_(pr=7)),
        ("excerpt-pr-long-truncates", with_(pr="p" * 150 + "\U0001F600" * 80)),
        ("profile-monorepo", with_(profile="monorepo")),
        ("profile-unknown-is-ignored", with_(profile="galaxy")),
    ]
    shapes = [
        ("valid", {"id": "i", "rule": "head-moved", "finding": "f", "severity": "blocker", "excerpt": "e"}),
        ("valid-extra-keys-allowed", {"id": "i", "rule": "lane-skipped", "finding": "f", "severity": "minor",
                                      "excerpt": "e", "zz": 1}),
        ("empty", {}),
        ("unknown-rule", {"id": "i", "rule": "clean", "finding": "f", "severity": "major", "excerpt": "e"}),
        ("null-rule", {"id": "i", "rule": None, "finding": "f", "severity": "major", "excerpt": "e"}),
        ("unknown-severity", {"id": "i", "rule": "head-moved", "finding": "f", "severity": "P0", "excerpt": "e"}),
        ("not-a-mapping-list", []),
        ("not-a-mapping-float", 0.5),
    ]
    constants = {name: (dict(getattr(gc, name)) if isinstance(getattr(gc, name), dict)
                        else list(getattr(gc, name)))
                 for name in ("VERDICTS", "SEVERITIES", "FINDING_FIELDS", "RULES", "RULE_VERDICTS", "PROFILES")}
    return {"constants": constants, "clean_observation": clean,
            "evaluate": cases_of(lambda o: lane_result(gc.evaluate(o)), observations, "observation"),
            "validate": cases_of(gc.validate_finding, shapes, "finding")}


def tpg_cases(tpg):
    claim, gate, render = tpg.clean_claim(), tpg.clean_gate(), tpg.clean_render()
    review, policy, rendering = tpg.clean_review(), tpg.clean_policy(), tpg.clean_rendering()

    def w(base, **changes):
        out = json.loads(json.dumps(base))
        out.update(changes)
        return out

    def jobs(**changes):
        return w(gate, jobs=w(gate["jobs"], **changes))

    claims = [
        ("clean", claim), ("not-a-mapping-null", None), ("not-a-mapping-list", []), ("not-a-mapping-int", 3),
        ("writers-missing", {"slice": "issue-1"}), ("writers-empty", w(claim, writers=[])),
        ("writers-two", w(claim, writers=["a", "b"])), ("writers-string", w(claim, writers="ab")),
        ("writers-mapping-repr", w(claim, writers={"a": 1})), ("writers-one-empty-name", w(claim, writers=[""])),
        ("slice-missing", {"writers": ["b"]}), ("slice-empty", w(claim, slice="")), ("slice-zero", w(claim, slice=0)),
        ("second-tracker", w(claim, second_tracker=True)), ("second-tracker-truthy-string", w(claim, second_tracker="no")),
        ("every-violation", {"writers": None, "slice": "", "second_tracker": 1}),
    ]
    gates = [
        ("clean", gate), ("clean-custom-jobs", tpg.clean_gate({"build": "success", "test": "success"})),
        ("not-a-mapping-null", None), ("not-a-mapping-list", [gate]),
        ("jobs-missing", {"tested_sha": "h", "head_sha": "h", "summary": True}), ("jobs-empty", w(gate, jobs={})),
        ("jobs-list", w(gate, jobs=["success"])),
        ("failure", jobs(tests="failure")), ("cancelled", jobs(tests="cancelled")), ("skipped", jobs(tests="skipped")),
        ("neutral", jobs(tests="neutral")), ("null-conclusion", jobs(tests=None)),
        ("success-is-case-sensitive", jobs(tests="Success")), ("empty-conclusion", jobs(tests="")),
        ("list-conclusion-repr", jobs(tests=["success"])), ("bool-conclusion", jobs(tests=True)),
        ("failing-jobs-in-sorted-order", jobs(zeta="failure", alpha="skipped")),
        ("failing-jobs-code-point-order", w(gate, jobs={"\U0001F600": "failure", "\uffff": "failure", "a": "x"})),
        ("stale-tested-sha", w(gate, tested_sha="old", head_sha="new")),
        ("tested-sha-missing-skips-exact-head", {"jobs": gate["jobs"], "head_sha": "new", "summary": True}),
        ("head-sha-missing-skips-exact-head", {"jobs": gate["jobs"], "tested_sha": "old", "summary": True}),
        ("tested-sha-null-skips-exact-head", w(gate, tested_sha=None, head_sha="new")),
        ("sha-number-vs-string", w(gate, tested_sha=1, head_sha="1")),
        ("sha-one-equals-true", w(gate, tested_sha=1, head_sha=True)),
        ("sha-lists-compare-by-value", w(gate, tested_sha=[1, "a"], head_sha=[1, "a"])),
        ("sha-mappings-compare-by-value", w(gate, tested_sha={"a": [1]}, head_sha={"a": [1]})),
        ("sha-lists-differ", w(gate, tested_sha=[1], head_sha=[2])),
        ("summary-missing", {"jobs": gate["jobs"], "tested_sha": "h", "head_sha": "h"}),
        ("summary-truthy-string", w(gate, summary="true")), ("summary-one", w(gate, summary=1)),
        ("every-violation", {"jobs": {"b": "skipped", "a": "failure"}, "tested_sha": "x", "head_sha": "y"}),
    ]
    renders = [
        ("clean", render), ("not-a-mapping-null", None), ("needs-not-a-list", w(render, needs="setup")),
        ("expected-not-a-list", w(render, expected_jobs=None)), ("drift", w(render, needs=["setup", "tests"])),
        ("order-only-is-clean", w(render, needs=list(reversed(render["needs"])))),
        ("duplicates-are-a-set", w(render, needs=["setup", "setup"], expected_jobs=["setup"])),
        ("one-equals-true-in-a-set", w(render, needs=[1], expected_jobs=[True])),
        ("drift-mixed-types-raise-on-sort", w(render, needs=["a", 1], expected_jobs=["a"])),
        ("drift-code-point-sort", w(render, needs=["\U0001F600", "\uffff"], expected_jobs=["a"])),
        ("unhashable-raises", w(render, needs=[["setup"]], expected_jobs=[["setup"]])),
        ("stubs-two", w(render, stubs=["llm_review", "lint"])), ("stubs-string-iterates", w(render, stubs="ab")),
        ("stubs-mapping-iterates-keys", w(render, stubs={"k": 1})), ("stubs-number-raises", w(render, stubs=5)),
        ("stubs-zero-is-empty", w(render, stubs=0)), ("stubs-null", w(render, stubs=None)),
        ("stubs-missing", {"needs": ["a"], "expected_jobs": ["a"]}),
        ("drift-and-stub", {"needs": ["a"], "expected_jobs": ["b"], "stubs": ["c"]}),
    ]
    reviews = [
        ("clean", review), ("uncalled", tpg.clean_review(uncalled=True)), ("not-a-mapping-null", None),
        ("called-truthy-string-is-not-called", w(review, called="true", reviewer_model="")),
        ("called-one-is-not-called", w(review, called=1, reviewer_model="")),
        ("empty-model", w(review, reviewer_model="")), ("null-builder", w(review, builder_provider_family=None)),
        ("zero-reviewer", w(review, reviewer_provider_family=0)),
        ("missing-inputs", {"called": True}),
        ("same-provider", w(review, reviewer_provider_family="anthropic")),
        ("provider-case-differs", w(review, reviewer_provider_family="Anthropic")),
        ("same-provider-lists-by-value", w(review, builder_provider_family=["a"], reviewer_provider_family=["a"])),
        ("paths-filter", w(review, paths_filter=["apps/**"])), ("paths-filter-empty", w(review, paths_filter="")),
        ("every-violation", {"called": True, "builder_provider_family": "x", "reviewer_provider_family": "x",
                             "reviewer_model": "", "paths_filter": "a"}),
    ]
    policies = [
        ("clean", policy), ("not-a-mapping-null", None),
        ("checkout", w(policy, steps=["reconcile", "checkout"])),
        ("download-artifact", w(policy, steps=["download-artifact"])), ("shell", w(policy, steps=["shell"])),
        ("steps-string-iterates-chars", w(policy, steps="shell")),
        ("steps-mapping-iterates-keys", w(policy, steps={"checkout": 1})),
        ("steps-number-raises", w(policy, steps=3)), ("steps-null", w(policy, steps=None)),
        ("steps-list-member-repr", w(policy, steps=[["shell"]])),
        ("mirror-missing", {"steps": [], "required": False}), ("mirror-false", w(policy, mirror_equivalent=False)),
        ("mirror-truthy-string", w(policy, mirror_equivalent="true")),
        ("required", w(policy, required=True)), ("required-one-is-not-true", w(policy, required=1)),
        ("every-violation", {"steps": ["checkout", "shell"], "mirror_equivalent": None, "required": True}),
    ]
    renderings = [
        ("clean-azure-docs", rendering), ("not-a-mapping-null", None),
        ("github", {"harness": "github", "kind": "live", "live_yaml": True}),
        ("github-actions", {"harness": "github-actions", "kind": "live"}),
        ("github-yaml", {"harness": "github-yaml"}),
        ("github-case-differs", {"harness": "GitHub", "kind": "live"}),
        ("azure-live", w(rendering, kind="live")), ("azure-kind-missing", {"harness": "azure"}),
        ("azure-live-yaml", w(rendering, live_yaml=True)), ("harness-missing", {"kind": "docs"}),
        ("harness-list-repr", {"harness": ["github"], "kind": "live", "live_yaml": "y"}),
    ]
    constants = {name: list(getattr(tpg, name)) for name in (
        "TRACKER_CONTRACT", "PIPELINE_CONTRACT", "GATE_CONTRACT", "EXACT_SUCCESS_ONLY", "NON_SUCCESS_CONCLUSIONS",
        "MERGE_POLICY_FORBIDDEN_STEPS", "REVIEW_REQUIRED_INPUTS")}
    constants["AUTHORITATIVE_RENDERING"] = tpg.AUTHORITATIVE_RENDERING
    return {
        "constants": constants,
        "builders": {"claim": claim, "gate": gate, "gate_custom": tpg.clean_gate({"b": "success"}),
                     "render": render, "review": review, "review_uncalled": tpg.clean_review(uncalled=True),
                     "policy": policy, "rendering": rendering},
        "claim": cases_of(tpg.check_tracker_claim, claims, "record"),
        "gate": cases_of(tpg.check_gate_aggregation, gates, "record"),
        "render": cases_of(tpg.check_render_sync, renders, "record"),
        "review": cases_of(tpg.check_review_ownership, reviews, "record"),
        "policy": cases_of(tpg.check_merge_policy_metadata, policies, "record"),
        "rendering": cases_of(tpg.check_rendering_docs_only, renderings, "record"),
    }


def receipt_cases(cr):
    merged = [
        ("remote-truth", {"pr_state": "merged", "merge_commit": "abc"}), ("not-a-mapping-null", None),
        ("local-only", {"local_only": True, "pr_state": "merged", "merge_commit": "abc"}),
        ("local-only-truthy-string", {"local_only": "no"}),
        ("pr-state-missing", {"merge_commit": "abc"}), ("merge-commit-missing", {"pr_state": "merged"}),
        ("both-missing", {}),
        ("closed-unmerged-with-test-merge-sha-passes", {"pr_state": "closed", "merge_commit": "abc"}),
        ("open-with-test-merge-sha-passes", {"pr_state": "open", "merge_commit": "abc"}),
    ]
    cleaned = [
        ("cleaned-with-receipt", {"state": "CLEANED"}, "cl-1"), ("cleaned-without-receipt", {"state": "CLEANED"}, None),
        ("cleaned-empty-receipt", {"state": "CLEANED"}, ""), ("cleaned-mapping-receipt-empty", {"state": "CLEANED"}, {}),
        ("cleanup-pending", {"state": "CLEANUP_PENDING"}, None), ("recovery-required", {"state": "RECOVERY_REQUIRED"}, None),
        ("merged", {"state": "MERGED"}, None), ("excluded", {"state": "EXCLUDED"}, None),
        ("lowercase-is-unknown", {"state": "cleaned"}, "cl-1"), ("state-missing", {}, None),
        ("state-list-repr", {"state": ["CLEANED"]}, None), ("not-a-mapping-null", None, "cl-1"),
    ]
    exclusions = [
        ("excluded-with-rationale", {"excluded": True, "rationale_url": "https://x/1"}), ("not-a-mapping-null", None),
        ("excluded-without-rationale", {"excluded": True}),
        ("excluded-counted", {"excluded": True, "rationale_url": "https://x/1", "counted_delivered": True}),
        ("excluded-both-violations", {"excluded": True, "counted_delivered": True}),
        ("duplicate-counted", {"close_reason": "duplicate", "counted_delivered": True}),
        ("not-planned-counted", {"close_reason": "not-planned", "counted_delivered": True}),
        ("github-not-planned-spelling-counted-passes", {"close_reason": "not_planned", "counted_delivered": True}),
        ("completed-counted", {"close_reason": "completed", "counted_delivered": True}),
        ("excluded-and-duplicate-counted", {"excluded": True, "close_reason": "duplicate", "counted_delivered": True}),
        ("duplicate-not-counted", {"close_reason": "duplicate"}),
    ]
    parents = [
        ("not-closing", {"children": [{"id": "c1", "state": "OPEN"}]}), ("not-a-mapping-null", None),
        ("gated", {"closing": True, "children": [{"id": "c1", "state": "MERGED"}, {"id": "c2", "state": "CLEANED"},
                                                 {"id": "c3", "state": "EXCLUDED"}], "integration_proof": "p"}),
        ("open-child", {"closing": True, "children": [{"id": "c1", "state": "OPEN"}], "integration_proof": "p"}),
        ("child-state-missing", {"closing": True, "children": [{"id": "c1"}], "integration_proof": "p"}),
        ("child-id-missing", {"closing": True, "children": [{"state": "OPEN"}], "integration_proof": "p"}),
        ("child-not-a-mapping", {"closing": True, "children": ["c1"], "integration_proof": "p"}),
        ("children-string-iterates", {"closing": True, "children": "ab", "integration_proof": "p"}),
        ("children-number-raises", {"closing": True, "children": 2, "integration_proof": "p"}),
        ("children-missing-needs-proof", {"closing": True}),
        ("counts-alone", {"closing": True, "children": [{"id": "c1", "state": "MERGED"}]}),
        ("closing-truthy-string", {"closing": "no", "children": [], "integration_proof": ""}),
        ("every-violation", {"closing": True, "children": [{"id": "a", "state": None}, 3]}),
    ]
    duplicates = [
        ("noop", {"count_delta": 0}, {"count_delta": 0}), ("first-not-a-mapping", None, {}),
        ("replay-not-a-mapping", {}, []), ("double-count", {}, {"count_delta": 1}),
        ("delta-false-equals-zero", {}, {"count_delta": False}), ("delta-string-zero", {}, {"count_delta": "0"}),
        ("delta-missing", {}, {}), ("second-effect", {}, {"second_effect": True}),
        ("both", {}, {"count_delta": -1, "second_effect": "y"}),
    ]
    races = [
        ("refused", {"membership_changed": True, "outcome": "refused"}), ("not-a-mapping-null", None),
        ("re-evaluate", {"membership_changed": True, "outcome": "re-evaluate"}),
        ("silent-success", {"membership_changed": True, "outcome": "closed"}),
        ("invisible-outcome", {"membership_changed": True, "outcome": "ignored"}),
        ("outcome-missing", {"membership_changed": True}),
        ("no-race-closed", {"membership_changed": False, "outcome": "closed"}),
        ("race-truthy-string", {"membership_changed": "no", "outcome": "closed"}),
    ]
    maths = [
        ("exact", {"merged_child_receipts": 3, "completed": 3}), ("not-a-mapping-null", None),
        ("wrong", {"merged_child_receipts": 3, "completed": 5}), ("missing-keys", {}),
        ("true-equals-one", {"merged_child_receipts": 1, "completed": True}),
        ("string-count", {"merged_child_receipts": 3, "completed": "3"}),
        ("excluded-delivered", {"merged_child_receipts": 2, "completed": 2, "counts_excluded_delivered": True}),
        ("both", {"merged_child_receipts": 2, "completed": 1, "counts_excluded_delivered": 1}),
    ]
    return {
        "constants": {"RECEIPT_STATES": list(cr.RECEIPT_STATES)},
        "merged": cases_of(cr.check_merged_receipt, merged, "record"),
        "cleaned": [{"label": label, "record": canonical(record), "cleanup_receipt": canonical(cleanup),
                     "result": guarded(lambda r=record, c=cleanup: cr.check_cleaned_receipt(canonical(r), canonical(c)))}
                    for label, record, cleanup in cleaned],
        "exclusion": cases_of(cr.check_exclusion, exclusions, "record"),
        "parent": cases_of(cr.check_parent_gate, parents, "record"),
        "duplicate": [{"label": label, "record": canonical(first), "replay": canonical(replay),
                       "result": guarded(lambda f=first, r=replay: cr.check_duplicate_noop(canonical(f), canonical(r)))}
                      for label, first, replay in duplicates],
        "race": cases_of(cr.check_membership_race, races, "record"),
        "tracker": cases_of(cr.check_tracker_math, maths, "record"),
    }


def owner_label_cases(sc):
    owner, label = "kgsmith19", "owner:queue-exempt"

    def labeled(login, name=label):
        return {"event": "labeled", "label": {"name": name}, "actor": {"login": login}}

    def unlabeled(login="anyone", name=label):
        return {"event": "unlabeled", "label": {"name": name}, "actor": {"login": login}}

    github = [
        ("empty-timeline", []),
        ("owner-labeled", [labeled(owner)]),
        ("other-labeled", [labeled("someone")]),
        ("owner-then-unlabeled", [labeled(owner), unlabeled(owner)]),
        ("unlabeled-then-owner", [unlabeled(), labeled(owner)]),
        ("owner-then-other-relabel", [labeled(owner), labeled("someone")]),
        ("other-then-owner-relabel", [labeled("someone"), labeled(owner)]),
        ("other-label-ignored", [labeled(owner, "owner:hold-merge")]),
        ("other-label-unlabel-ignored", [labeled(owner), unlabeled(owner, "owner:hold-merge")]),
        ("unrelated-events-ignored", [labeled(owner), {"event": "commented", "actor": {"login": "x"}},
                                      {"event": "head_ref_force_pushed"}]),
        ("login-case-sensitive", [labeled("KGSmith19")]),
        ("label-case-sensitive", [labeled(owner, "Owner:Queue-Exempt")]),
        ("label-name-fallback", [{"event": "labeled", "label_name": label, "actor": {"login": owner}}]),
        ("actor-login-fallback", [{"event": "labeled", "label": {"name": label}, "actor_login": owner}]),
        ("actor-missing", [{"event": "labeled", "label": {"name": label}}]),
        ("actor-null", [{"event": "labeled", "label": {"name": label}, "actor": None}]),
        ("label-null-falls-back", [{"event": "labeled", "label": None, "label_name": label, "actor": {"login": owner}}]),
        ("ghost-actor", [{"event": "labeled", "label": {"name": label}, "actor": {"login": "ghost"}}]),
    ]
    malformed = [
        ("label-name-empty-list-falls-back",
         [{"event": "labeled", "label": {"name": []}, "label_name": label, "actor": {"login": owner}}]),
        ("label-name-empty-mapping-falls-back",
         [{"event": "labeled", "label": {"name": {}}, "label_name": label, "actor": {"login": owner}}]),
        ("actor-login-empty-list-falls-back",
         [{"event": "labeled", "label": {"name": label}, "actor": {"login": []}, "actor_login": owner}]),
        ("label-string-is-not-a-mapping",
         [{"event": "labeled", "label": label, "label_name": label, "actor": {"login": owner}}]),
        ("actor-string-is-not-a-mapping",
         [{"event": "labeled", "label": {"name": label}, "actor": owner, "actor_login": owner}]),
    ]
    out = []
    for shape, cases in (("github", github), ("malformed", malformed)):
        for name, events in cases:
            out.append({"label": name, "shape": shape, "events": canonical(events), "label_name": label,
                        "owner": owner, "result": guarded(lambda e=events: sc.owner_label_authorized(
                            canonical(e), label, owner))})
    return out


def corpus_cases(checkout, gc, tpg, cr):
    lane = []
    for entry in corpus(checkout, CORPORA["lane"])["entries"]:
        out = canonical(entry)
        out["result"] = lane_result(gc.evaluate(canonical(entry.get("observation", {}))))
        lane.append(out)
    checkers = {"tracker": tpg.check_tracker_claim, "gate": tpg.check_gate_aggregation,
                "render": tpg.check_render_sync, "review": tpg.check_review_ownership,
                "policy": tpg.check_merge_policy_metadata, "azure": tpg.check_rendering_docs_only}
    rendering = []
    for entry in corpus(checkout, CORPORA["rendering"])["entries"]:
        out = canonical(entry)
        out["violations"] = checkers[entry["target"]](canonical(entry.get("record")))
        rendering.append(out)
    receipts = []
    for entry in corpus(checkout, CORPORA["receipts"])["entries"]:
        out = canonical(entry)
        record, target = canonical(entry.get("record")), entry["target"]
        if target == "cleaned":
            violations = cr.check_cleaned_receipt(record, canonical(entry.get("cleanup_receipt")))
        elif target == "duplicate":
            violations = cr.check_duplicate_noop(record, canonical(entry.get("replay", {})))
        else:
            violations = {"merged": cr.check_merged_receipt, "exclusion": cr.check_exclusion,
                          "parent": cr.check_parent_gate, "race": cr.check_membership_race,
                          "tracker": cr.check_tracker_math}[target](record)
        out["violations"] = violations
        receipts.append(out)
    return {"lane": lane, "rendering": rendering, "receipts": receipts}


def render(golden):
    """Sections of cases, one case per line (same layout as the S5-S8 goldens)."""
    def dumps(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))

    def block(cases):
        return "[\n" + ",\n".join("   " + dumps(case) for case in cases) + "\n  ]"

    lines = ['"_generator":%s' % dumps(golden["_generator"]),
             '"_provenance":%s' % dumps(golden["_provenance"]),
             '"_python":%s' % dumps(golden["_python"]),
             '"owner_label":%s' % block(golden["owner_label"])]
    for section in ("lane", "tpg", "receipts", "corpus"):
        parts = []
        for key in sorted(golden[section]):
            value = golden[section][key]
            parts.append('"%s":%s' % (key, block(value) if isinstance(value, list) else dumps(value)))
        lines.append('"%s":{\n  %s\n }' % (section, ",\n  ".join(parts)))
    return "{\n " + ",\n ".join(lines) + "\n}\n"


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    gc, tpg, cr, sc = (_S5.load(sys.argv[1], name) for name in MODULES)
    golden = {
        "_provenance": "agent-engineering-standard @ %s: tools/%s.py (owner_label_authorized) + %s" % (
            SHA, ".py + tools/".join(MODULES), " + ".join(sorted(CORPORA.values()))),
        "_generator": "docs/ops/stage63-gate-golden.py",
        "_python": "%d.%d" % sys.version_info[:2],
        "owner_label": owner_label_cases(sc),
        "lane": lane_cases(gc),
        "tpg": tpg_cases(tpg),
        "receipts": receipt_cases(cr),
        "corpus": corpus_cases(sys.argv[1], gc, tpg, cr),
    }
    sys.stdout.write(render(golden))


if __name__ == "__main__":
    main()
