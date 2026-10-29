#!/usr/bin/env python3
"""Regenerate docs/ops/role-contract-golden.json (#467 S2b).

Independent oracle for docs/ops/role-contract-lib.mjs, the hand port of the
Standard's runtime-neutral role contract: tools/role_contract.py (std#300
decide, std#301 record) and the tools/role_authority.py rules it reuses. Every
result is computed by the upstream Python loaded straight from the commit
standard.lock pins, through the stage-63 loader (stage63-continuity-golden.py).

    python3.12 docs/ops/role-contract-golden.py <agent-engineering-standard checkout> \
        > docs/ops/role-contract-golden.json

Three sets: the frozen upstream corpus (Canonical/corpus/role-contract), its
collaboration flows replayed through record(), and edge cases built here that
probe the Python semantics a JS port gets wrong by default: Unicode digits in
timestamps (strptime's own field patterns), "$" matching before a trailing
newline, str() of non-strings, str.strip()'s whitespace set, and truthiness.

Every input is canonicalized through a sorted-keys JSON round trip before the
upstream call, so Python reads exactly what the JS replay reads back.
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
CORPUS = "Canonical/corpus/role-contract/contracts.json"

HEAD = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
OTHER_HEAD = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
HASH = "4" * 64


def canonical(value):
    """The value as the JS replay reads it back: sorted keys, JSON types."""
    return json.loads(json.dumps(value, sort_keys=True))


def load_modules(checkout):
    ra = _S5.load(checkout, "role_authority")
    sys.modules["role_authority"] = ra  # role_contract does `import role_authority as ra`
    return ra, _S5.load(checkout, "role_contract")


def corpus(checkout):
    return json.loads(subprocess.run(
        ["git", "-C", checkout, "show", "%s:%s" % (SHA, CORPUS)],
        check=True, capture_output=True, text=True).stdout)


def grant(**overrides):
    base = {
        "actor_id": "builder-1", "run_id": "run-1", "duty": "builder", "scope": ["src/"],
        "head_sha": HEAD, "provider": {"family": "anthropic", "model": "tier-a"},
        "provenance": {"source": "harness", "provider_observed": "anthropic/tier-a"},
        "issued_at": "2026-10-28T10:00:00Z", "expires_at": "2026-10-28T10:30:00Z",
        "grantor": "orchestrator-1",
    }
    for key, value in overrides.items():
        if value is _DROP:
            base.pop(key, None)
        else:
            base[key] = value
    return base


_DROP = object()
NOW = "2026-10-28T10:10:00Z"
WRITE = {"kind": "write", "risk": "R2", "path": "src/a.py"}


def verifier(**overrides):
    return grant(**dict({"actor_id": "verifier-1", "duty": "verifier", "scope": ["evidence/verification/"],
                         "provider": {"family": "openai", "model": "tier-b"},
                         "provenance": {"source": "harness", "provider_observed": "openai/tier-b"}},
                        **overrides))


def decide_cases():
    """(id, kwargs) pairs; kwargs are decide()'s arguments."""
    cases = []

    def add(case_id, g=None, action=None, **kwargs):
        kwargs.setdefault("now", NOW)
        kwargs.setdefault("current_head", HEAD)
        cases.append((case_id, dict(grant=grant() if g is None else g,
                                    action=WRITE if action is None else action, **kwargs)))

    add("base-allow")
    # --- timestamps: _TS_RE's \d is Unicode, strptime's field patterns are not everywhere
    arabic = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")
    fullwidth = str.maketrans("0123456789", "０１２３４５６７８９")
    add("ts-arabic-indic-all", grant(issued_at="2026-10-28T10:00:00Z".translate(arabic)))
    add("ts-arabic-year-only", grant(issued_at="٢٠٢٦-10-28T10:00:00Z"))
    add("ts-fullwidth-year-only", grant(issued_at="２０２６-10-28T10:00:00Z"))
    add("ts-unicode-month-second-digit", grant(issued_at="2026-1٠-28T10:00:00Z"))
    add("ts-unicode-day-second-digit", grant(issued_at="2026-10-2٨T10:00:00Z"))
    add("ts-unicode-day-first-digit", grant(issued_at="2026-10-٢8T10:00:00Z"))
    add("ts-unicode-hour-second-digit", grant(issued_at="2026-10-28T1٠:00:00Z"))
    add("ts-unicode-hour-first-digit", grant(issued_at="2026-10-28T٠9:00:00Z"))
    add("ts-unicode-minute-second-digit", grant(issued_at="2026-10-28T10:0٥:00Z"))
    add("ts-unicode-second-second-digit", grant(issued_at="2026-10-28T10:00:0٩Z"))
    add("ts-math-digits-year", grant(issued_at="\U0001d7ee\U0001d7ec\U0001d7ee\U0001d7f2-10-28T10:00:00Z"))
    add("ts-trailing-newline", grant(issued_at="2026-10-28T10:00:00Z\n"))
    add("ts-lowercase-t", grant(issued_at="2026-10-28t10:00:00Z"))
    add("ts-fraction", grant(issued_at="2026-10-28T10:00:00.5Z"))
    add("ts-offset", grant(issued_at="2026-10-28T10:00:00+00:00"))
    add("ts-month-13", grant(issued_at="2026-13-28T10:00:00Z"))
    add("ts-month-00", grant(issued_at="2026-00-28T10:00:00Z"))
    add("ts-feb-29-leap", grant(issued_at="2028-02-29T10:00:00Z", expires_at="2028-02-29T10:30:00Z"),
        now="2028-02-29T10:10:00Z")
    add("ts-feb-29-common", grant(issued_at="2027-02-29T10:00:00Z", expires_at="2027-02-29T10:30:00Z"))
    add("ts-feb-29-century", grant(issued_at="2100-02-29T10:00:00Z", expires_at="2100-02-29T10:30:00Z"))
    add("ts-feb-29-400", grant(issued_at="2000-02-29T10:00:00Z", expires_at="2000-02-29T10:30:00Z"),
        now="2000-02-29T10:10:00Z")
    add("ts-apr-31", grant(issued_at="2026-04-31T10:00:00Z"))
    add("ts-hour-24", grant(issued_at="2026-10-28T24:00:00Z"))
    add("ts-minute-60", grant(issued_at="2026-10-28T10:60:00Z"))
    add("ts-second-60", grant(issued_at="2026-10-28T10:00:60Z"))
    add("ts-second-61", grant(issued_at="2026-10-28T10:00:61Z"))
    add("ts-year-0000", grant(issued_at="0000-10-28T10:00:00Z"))
    add("ts-year-0000-both", grant(issued_at="0000-12-31T23:40:00Z", expires_at="0000-12-31T23:59:00Z"),
        now="0000-12-31T23:50:00Z")
    add("ts-year-0001", grant(issued_at="0001-01-01T00:00:00Z", expires_at="0001-01-01T00:30:00Z"),
        now="0001-01-01T00:10:00Z")
    add("ts-year-0099", grant(issued_at="0099-12-31T23:40:00Z", expires_at="0099-12-31T23:59:59Z"),
        now="0099-12-31T23:50:00Z")
    add("ts-across-midnight", grant(issued_at="2026-12-31T23:45:00Z", expires_at="2027-01-01T00:15:00Z"),
        now="2027-01-01T00:00:00Z")
    add("ts-not-a-string", grant(issued_at=1761645600))
    add("window-exactly-3600", grant(expires_at="2026-10-28T11:00:00Z"))
    add("window-3601", grant(expires_at="2026-10-28T11:00:01Z"))
    add("window-zero", grant(expires_at="2026-10-28T10:00:00Z"))
    add("window-negative", grant(expires_at="2026-10-28T09:59:59Z"))
    add("now-equals-issued", now="2026-10-28T10:00:00Z")
    add("now-equals-expires", now="2026-10-28T10:30:00Z")
    add("now-one-second-before-issue", now="2026-10-28T09:59:59Z")
    add("now-unparseable", now="soon")
    add("now-null", now=None)
    add("now-unicode-second-digit", now="2026-10-28T10:1٠:00Z")
    # --- head: "$" matches before one trailing newline
    add("head-trailing-newline", grant(head_sha=HEAD + "\n"))
    add("head-trailing-newline-both", grant(head_sha=HEAD + "\n"), current_head=HEAD + "\n")
    add("head-two-newlines", grant(head_sha=HEAD + "\n\n"))
    add("head-uppercase", grant(head_sha=HEAD.upper()))
    add("head-39", grant(head_sha=HEAD[:39]))
    add("head-stale", current_head=OTHER_HEAD)
    add("current-head-null", current_head=None)
    add("current-head-int", current_head=1)
    # --- text fields: str.strip()'s whitespace set, not trim()'s
    for name, pad in (("u001c", "\x1c"), ("u001f", "\x1f"), ("u0085", "\x85"), ("ufeff", "﻿"),
                      ("u3000", "　"), ("u200b", "​")):
        add("actor-pad-" + name, grant(actor_id=pad))
        add("grantor-pad-" + name, grant(grantor=pad))
        add("source-pad-" + name, grant(provenance={"source": pad, "provider_observed": "anthropic/x"}))
        add("observed-pad-" + name, grant(provenance={"source": "h", "provider_observed": pad}))
        add("family-pad-" + name, grant(provider={"family": pad + "anthropic" + pad, "model": "x"}))
        add("scope-pad-" + name, grant(scope=[pad + "src/" + pad]))
        add("identity-pad-" + name, grant(github_identity=pad), action={"kind": "post"})
    # --- shape
    add("grant-not-mapping", ["builder"])
    add("grant-null", None)
    add("grant-extra-key", grant(extra=1))
    for key in ("actor_id", "run_id", "duty", "scope", "head_sha", "provider", "provenance",
                "issued_at", "expires_at", "grantor"):
        add("grant-missing-" + key.replace("_", "-"), grant(**{key: _DROP}))
    add("duty-unknown", grant(duty="controller"))
    add("duty-list", grant(duty=["builder"]))
    add("duty-int", grant(duty=1))
    add("duty-case", grant(duty="Builder"))
    add("scope-empty", grant(scope=[]))
    add("scope-string", grant(scope="src/"))
    add("scope-traversal", grant(scope=["../src/"]))
    add("scope-dot", grant(scope=["./"]))
    add("scope-int", grant(scope=[1]))
    add("scope-backslash", grant(scope=["src\\"]), action={"kind": "write", "path": "src\\a.py"})
    add("scope-leading-slash", grant(scope=["/src/"]))
    add("scope-inner-dotdot", grant(scope=["src/x/../"]))
    add("provider-extra-key", grant(provider={"family": "anthropic", "model": "x", "tier": 1}))
    add("provider-missing-model", grant(provider={"family": "anthropic"}))
    add("provider-model-blank", grant(provider={"family": "anthropic", "model": " "}))
    add("provider-not-mapping", grant(provider="anthropic"))
    add("provenance-extra-key", grant(provenance={"source": "h", "provider_observed": "anthropic", "x": 1}))
    add("observed-int", grant(provenance={"source": "h", "provider_observed": 1}))
    add("observed-null", grant(provenance={"source": "h", "provider_observed": None}))
    add("identity-int", grant(github_identity=1))
    add("identity-null", grant(github_identity=None))
    add("action-not-mapping", action="write")
    add("action-extra-key", action={"kind": "write", "path": "src/a.py", "x": 1})
    add("action-kind-unknown", action={"kind": "delete", "path": "src/a.py"})
    add("action-kind-missing", action={"path": "src/a.py"})
    add("action-path-int", action={"kind": "write", "path": 1})
    add("action-path-null", action={"kind": "write", "path": None})
    add("other-grants-mapping", other_grants={"a": 1})
    add("other-grants-string", other_grants="x")
    add("other-grants-malformed", other_grants=[{"actor_id": "x"}])
    # --- provenance family
    add("observed-no-slash", grant(provenance={"source": "h", "provider_observed": "anthropic"}))
    add("observed-upper", grant(provenance={"source": "h", "provider_observed": "ANTHROPIC/x"}))
    add("observed-spaced", grant(provenance={"source": "h", "provider_observed": " anthropic / x"}))
    add("observed-other-family", grant(provenance={"source": "h", "provider_observed": "openai/x"}))
    add("observed-dotted-i", grant(provider={"family": "İx", "model": "m"},
                                   provenance={"source": "h", "provider_observed": "i̇x/m"}))
    add("observed-sharp-s", grant(provider={"family": "straße", "model": "m"},
                                  provenance={"source": "h", "provider_observed": "STRASSE/m"}))
    # --- paths (std's role path matrix)
    for name, path in (("bare-dir", "src"), ("sibling", "src-evil/a.py"), ("backslash", "src\\a.py"),
                       ("leading-slash", "/src/a.py"), ("dot", "./src/a.py"), ("inner-dot", "src/./a.py"),
                       ("dotdot-out", "src/../tools/x.py"), ("traversal", "../src/a.py"),
                       ("frozen", "Canonical/corpus/x.json"), ("frozen-root", "Canonical/corpus"),
                       ("forbidden", ".github/workflows/x.yml"), ("outside-roots", "docs/a.md"),
                       ("padded", " src/a.py "), ("empty", ""), ("pad-u001c", "\x1csrc/a.py")):
        add("path-" + name, action={"kind": "write", "risk": "R2", "path": path})
    add("write-no-path", action={"kind": "write"})
    add("review-no-path", verifier(), action={"kind": "review", "risk": "R2"})
    add("remediator-src", grant(duty="remediator"), action={"kind": "write", "path": "src/a.py"})
    add("remediator-corpus", grant(duty="remediator", scope=["Canonical/"]),
        action={"kind": "write", "path": "Canonical/corpus/a.json"})
    # --- risk
    builder = grant()
    for name, risk in (("r1", "R1"), ("r2", "R2"), ("r3", "R3"), ("lower", "r2"), ("missing", _DROP),
                       ("int", 2), ("unknown", "R9")):
        action = {"kind": "review"}
        if risk is not _DROP:
            action["risk"] = risk
        add("review-same-family-" + name,
            verifier(provider={"family": "anthropic", "model": "x"},
                     provenance={"source": "h", "provider_observed": "anthropic/x"}),
            action=action, other_grants=[builder])
    add("review-by-builder", grant(), action={"kind": "review", "risk": "R1"})
    add("review-same-actor", verifier(actor_id="builder-1"), action={"kind": "verify", "risk": "R2"},
        other_grants=[builder])
    add("review-other-head-builder", verifier(provider={"family": "anthropic", "model": "x"},
                                              provenance={"source": "h", "provider_observed": "anthropic/x"}),
        action={"kind": "review", "risk": "R3"}, other_grants=[grant(head_sha=OTHER_HEAD)])
    # --- parallel writes
    add("parallel-overlap", other_grants=[grant(actor_id="builder-2", scope=["src/api/"])])
    add("parallel-disjoint", other_grants=[grant(actor_id="builder-2", scope=["srcx/"])])
    add("parallel-remediator", other_grants=[grant(actor_id="r-1", duty="remediator", scope=["src/"])])
    add("parallel-verifier-ignored", other_grants=[verifier(scope=["src/"])])
    add("parallel-other-head", other_grants=[grant(actor_id="builder-2", head_sha=OTHER_HEAD)])
    # --- self-grant, owner, delegation
    add("self-grant", grant(grantor="builder-1"))
    add("self-grant-owner", grant(actor_id="kgsmith19", grantor="kgsmith19"), owner="kgsmith19")
    add("self-grant-owner-not-passed", grant(actor_id="kgsmith19", grantor="kgsmith19"))
    for name, value in (("true", True), ("one", 1), ("yes", "yes"), ("zero", 0), ("empty", ""),
                        ("list", [0]), ("empty-list", []), ("null", None)):
        add("delegated-" + name, delegated=value)
    add("delegated-held", delegated=True,
        other_grants=[grant(actor_id="orchestrator-1", scope=["plans/"])])
    add("delegated-owner", grant(grantor="kgsmith19"), delegated=True, owner="kgsmith19")
    add("delegated-owner-mismatch", grant(grantor="kgsmith19"), delegated=True, owner="someone")
    # --- GitHub writes
    for kind in ("post", "mutate_github"):
        add(kind + "-no-identity", action={"kind": kind})
        add(kind + "-identity", grant(github_identity="dev-app[bot]"), action={"kind": kind})
        add(kind + "-blank-identity", grant(github_identity=""), action={"kind": kind})
    # --- owner override
    stale = dict(current_head=OTHER_HEAD, now="2026-10-28T11:00:00Z")
    ok = {"owner": "kgsmith19", "decision": "waive", "scope": "#467"}
    add("override-honored", override=ok, **stale)
    add("override-honored-owner-kw", override=ok, owner="kgsmith19", **stale)
    add("override-owner-kw-mismatch", override=ok, owner="someone", **stale)
    add("override-owner-kw-list", override=ok, owner=["kgsmith19"], **stale)
    add("override-owner-kw-int", override=ok, owner=1, **stale)
    add("override-wrong-owner", override=dict(ok, owner="someone"), **stale)
    add("override-owner-null", override=dict(ok, owner=None), **stale)
    add("override-owner-missing", override={"decision": "waive", "scope": "#467"}, **stale)
    add("override-blank-decision", override=dict(ok, decision=" "), **stale)
    add("override-pad-decision", override=dict(ok, decision="\x1c"), **stale)
    add("override-blank-scope", override=dict(ok, scope=""), **stale)
    add("override-scope-int", override=dict(ok, scope=0), **stale)
    add("override-decision-list", override=dict(ok, decision=[]), **stale)
    add("override-not-mapping", override="kgsmith19", **stale)
    add("override-empty-mapping", override={}, **stale)
    add("override-cannot-waive-self-grant", grant(grantor="builder-1"), override=ok)
    add("override-cannot-waive-scope", action={"kind": "write", "path": "docs/a.md"}, override=ok)
    return cases


def record_cases():
    """(id, kwargs) pairs; kwargs are record()'s arguments."""
    cases = []
    out = [{"path": "evidence/verification/r.json", "sha256": HASH}]
    claim = {"id": "AC1", "result": "pass", "artifacts": ["evidence/verification/r.json"]}

    def add(case_id, g=None, action=None, **kwargs):
        kwargs.setdefault("task", "#467")
        kwargs.setdefault("now", NOW)
        kwargs.setdefault("current_head", HEAD)
        cases.append((case_id, dict(grant=verifier() if g is None else g,
                                    action={"kind": "verify", "risk": "R2"} if action is None else action,
                                    **kwargs)))

    add("verifier-proven", acceptance_ids=["AC1"], claims=[claim], output_artifacts=out)
    add("verifier-no-ids", claims=[claim], output_artifacts=out)
    add("verifier-claim-fails", acceptance_ids=["AC1"], claims=[dict(claim, result="fail")],
        output_artifacts=out)
    add("verifier-result-upper", acceptance_ids=["AC1"], claims=[dict(claim, result="PASS")],
        output_artifacts=out)
    add("verifier-artifact-not-produced", acceptance_ids=["AC1"], claims=[claim],
        output_artifacts=[{"path": "evidence/other.json", "sha256": HASH}])
    add("verifier-second-id-unproven", acceptance_ids=["AC1", "AC2"], claims=[claim], output_artifacts=out)
    add("verifier-hash-trailing-newline", acceptance_ids=["AC1"], claims=[claim],
        output_artifacts=[{"path": "evidence/verification/r.json", "sha256": HASH + "\n"}])
    add("verifier-hash-upper", acceptance_ids=["AC1"], claims=[claim],
        output_artifacts=[{"path": "evidence/verification/r.json", "sha256": HASH.upper()}])
    add("artifact-extra-key", acceptance_ids=["AC1"], claims=[claim],
        output_artifacts=[dict(out[0], size=1)])
    add("input-artifacts-malformed", acceptance_ids=["AC1"], claims=[claim], output_artifacts=out,
        input_artifacts=[{"path": "x"}])
    add("input-artifacts-not-list", acceptance_ids=["AC1"], claims=[claim], output_artifacts=out,
        input_artifacts={"path": "x", "sha256": HASH})
    add("ids-not-list", acceptance_ids="AC1", claims=[claim], output_artifacts=out)
    add("ids-blank", acceptance_ids=["\x1f"], claims=[claim], output_artifacts=out)
    add("claim-not-mapping", acceptance_ids=["AC1"], claims=["AC1"], output_artifacts=out)
    add("claim-artifacts-string", acceptance_ids=["AC1"], claims=[dict(claim, artifacts="x")],
        output_artifacts=out)
    add("claim-artifact-blank", acceptance_ids=["AC1"], claims=[dict(claim, artifacts=[" "])],
        output_artifacts=out)
    add("specialty-text", specialty="security", acceptance_ids=["AC1"], claims=[claim], output_artifacts=out)
    add("specialty-blank", specialty="", acceptance_ids=["AC1"], claims=[claim], output_artifacts=out)
    add("specialty-int", specialty=1, acceptance_ids=["AC1"], claims=[claim], output_artifacts=out)
    add("reviewer-unproven", verifier(duty="reviewer", scope=["evidence/review/"]),
        action={"kind": "review", "risk": "R2"})
    add("builder-needs-no-evidence", grant(), action=WRITE)
    add("refused-grant-not-mapping", ["x"], acceptance_ids=["AC1"])
    add("refused-and-malformed", verifier(head_sha=OTHER_HEAD), acceptance_ids="AC1")
    add("task-and-now-passthrough", task={"issue": 467}, now="not-a-time", acceptance_ids=["AC1"],
        claims=[claim], output_artifacts=out)
    add("tuple-like-lists", acceptance_ids=["AC1"], claims=[claim], output_artifacts=out,
        input_artifacts=[])
    return cases


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    checkout = sys.argv[1]
    ra, rc = load_modules(checkout)
    doc = corpus(checkout)

    def run_decide(kwargs):
        kwargs = canonical(kwargs)
        g, action = kwargs.pop("grant"), kwargs.pop("action")
        allowed, rules = rc.decide(g, action, **kwargs)
        return kwargs, g, action, {"allowed": allowed, "rules": rules}

    decide_rows = []
    for case in doc["cases"]:
        kwargs = {key: case[key] for key in case if key not in ("id", "expect")}
        inputs, g, action, result = run_decide(kwargs)
        decide_rows.append({"id": case["id"], "source": "corpus", "grant": g, "action": action,
                            "kwargs": inputs, "result": result, "expect": case["expect"]})
    for case_id, kwargs in decide_cases():
        inputs, g, action, result = run_decide(copy.deepcopy(kwargs))
        decide_rows.append({"id": case_id, "source": "edge", "grant": g, "action": action,
                            "kwargs": inputs, "result": result})

    def run_record(kwargs):
        kwargs = canonical(kwargs)
        g, action = kwargs.pop("grant"), kwargs.pop("action")
        return kwargs, g, action, canonical(rc.record(g, action, **kwargs))

    record_rows = []
    for flow in doc["flows"]:
        for index, step in enumerate(flow["steps"]):
            kwargs = {key: step[key] for key in step if key != "expect"}
            inputs, g, action, receipt = run_record(kwargs)
            record_rows.append({"id": "%s.%d" % (flow["id"], index), "source": "corpus", "grant": g,
                                "action": action, "kwargs": inputs, "receipt": receipt,
                                "expect": step["expect"]})
    for case_id, kwargs in record_cases():
        inputs, g, action, receipt = run_record(copy.deepcopy(kwargs))
        record_rows.append({"id": case_id, "source": "edge", "grant": g, "action": action,
                            "kwargs": inputs, "receipt": receipt})

    golden = {
        "_provenance": "agent-engineering-standard @ %s: tools/role_contract.py + tools/role_authority.py + %s"
                       % (SHA, CORPUS),
        "_generator": "docs/ops/role-contract-golden.py",
        "_python": "%d.%d" % sys.version_info[:2],
        "constants": {
            "RULES": list(rc.RULES), "KINDS": list(rc.KINDS), "WAIVABLE": list(rc.WAIVABLE),
            "MAX_WINDOW_SECONDS": rc.MAX_WINDOW_SECONDS, "GRANT_KEYS": list(rc.GRANT_KEYS),
            "OPTIONAL_GRANT_KEYS": list(rc.OPTIONAL_GRANT_KEYS), "ROLES": list(ra.ROLES),
            "RISKS": list(ra.RISKS), "OWNER_LOGIN": ra.OWNER_LOGIN, "FROZEN_ROOTS": list(ra.FROZEN_ROOTS),
            "WRITE_PATHS": {k: list(v) for k, v in ra.WRITE_PATHS.items()},
            "FORBIDDEN_PATHS": {k: list(v) for k, v in ra.FORBIDDEN_PATHS.items()},
        },
        "decide": decide_rows,
        "record": record_rows,
    }
    sys.stdout.write(render(golden))


def render(golden):
    """One case per line: reviewable diffs without whitespace bloat."""
    def dumps(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))

    def block(rows):
        return "[\n" + ",\n".join("  " + dumps(row) for row in rows) + "\n ]"

    parts = ['"_generator":%s' % dumps(golden["_generator"]),
             '"_provenance":%s' % dumps(golden["_provenance"]),
             '"_python":%s' % dumps(golden["_python"]),
             '"constants":%s' % dumps(golden["constants"]),
             '"decide":%s' % block(golden["decide"]),
             '"record":%s' % block(golden["record"])]
    return "{\n " + ",\n ".join(parts) + "\n}\n"


if __name__ == "__main__":
    main()
