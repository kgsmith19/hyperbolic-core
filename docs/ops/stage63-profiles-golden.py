#!/usr/bin/env python3
"""Regenerate docs/ops/stage63-profiles-golden.json (Stage 63 S6, #424).

Independent oracle for the S6 extension-profile ports in
stage63-adoption-lib.mjs: every case is computed by the upstream Python
modules loaded straight from the pinned Standard commit, reusing the S5
generator's loader (stage63-continuity-golden.py).

    python3 docs/ops/stage63-profiles-golden.py <agent-engineering-standard checkout> \
        > docs/ops/stage63-profiles-golden.json

Activation times are either long past (2020) or far future (2999), so the
one clock-reading rule (stale sessions) is deterministic.
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
MODULES = ("mcp_profile", "extensions_registry", "profile_compiler")

LIFEOS = {
    "name": "lifeos", "transport": "stdio", "endpoint": "stdio:python -m mcp_server",
    "capabilities": ["list_types", "find", "get_entity", "history"], "kind": "read",
    "schema_bytes": 2048, "idempotent": True, "activated_at": None, "ttl_seconds": None,
}


def server(**overrides):
    record = dict(LIFEOS)
    record.update(overrides)
    for key, value in list(overrides.items()):
        if value == "<drop>":
            del record[key]
    return record


def mcp_cases(mcp):
    task = {"phase": "task", "provider": "claude"}
    research = {"phase": "research", "provider": "claude"}
    crowded = {
        "phase": "task", "provider": "claude",
        "active_servers": [server(name="a%d" % i) for i in range(3)],
        "candidate_servers": [server(name="c%d" % i) for i in range(5)]
        + [server(name="giant", schema_bytes=70000), server(name="idle", capabilities=[])],
    }
    activations = [
        ("lifeos-task", LIFEOS, task),
        ("lifeos-research", LIFEOS, research),
        ("write-in-research", server(kind="write", idempotent=True), research),
        ("write-not-idempotent", server(kind="write", idempotent=False), task),
        ("write-idempotent-task", server(kind="write", idempotent=True), task),
        ("missing-fields", server(endpoint="<drop>", kind="<drop>"), task),
        ("unnamed", {"transport": "stdio"}, task),
        ("bad-transport", server(transport="ws"), task),
        ("bad-kind", server(kind="admin"), task),
        ("schema-bytes-string", server(schema_bytes="big"), task),
        ("schema-bytes-bool", server(schema_bytes=True), task),
        ("secret-anthropic", server(endpoint="https://localhost/x?key=sk-ant-abc"), task),
        ("secret-capability", server(capabilities=["ghp_abc", "find"]), task),
        ("secret-aws", server(endpoint="cmd:run AKIAXYZ"), task),
        ("egress-denied", server(transport="http", endpoint="https://evil.example.com/mcp"), task),
        ("egress-localhost-port", server(transport="http", endpoint="http://localhost:8080/mcp"), task),
        ("egress-github", server(transport="http", endpoint="https://github.com/mcp"), task),
        ("egress-cmd", server(endpoint="cmd:lifeos"), task),
        ("egress-empty", server(endpoint=""), task),
        ("stale-session", server(activated_at="2020-01-01T00:00:00Z", ttl_seconds=60), task),
        ("live-session", server(activated_at="2999-01-01T00:00:00Z", ttl_seconds=60), task),
        ("offset-session", server(activated_at="2020-01-01T00:00:00+00:00", ttl_seconds="60"), task),
        ("naive-session", server(activated_at="2020-01-01T00:00:00", ttl_seconds=60), task),
        ("date-only-session", server(activated_at="2999-01-01", ttl_seconds=60), task),
        ("unparseable-session", server(activated_at="yesterday", ttl_seconds=60), task),
        ("no-ttl", server(activated_at="2020-01-01T00:00:00Z", ttl_seconds=0), task),
        ("native-duplicate", LIFEOS, dict(task, native_capabilities=["find"])),
        ("http-no-transport-key", server(transport="http", endpoint="https://localhost/m"),
         {"phase": "task", "provider": "kilo"}),
        ("http-codex", server(transport="http", endpoint="https://localhost/m"),
         {"phase": "task", "provider": "codex"}),
        ("default-profile", LIFEOS, {}),
        ("crowded-advisories", LIFEOS, crowded),
    ]
    profiles = [
        ("zero-standing", {"standing_servers": [], "active_servers": [LIFEOS]}),
        ("standing-declared", {"standing_servers": [LIFEOS, LIFEOS]}),
        ("malformed-candidate", {"candidate_servers": [server(kind="<drop>", transport="ws")]}),
        ("crowded", crowded),
        ("at-limits", {"active_servers": [server(name="a%d" % i) for i in range(2)],
                       "candidate_servers": [server(name="c%d" % i, schema_bytes=64 * 1024)
                                             for i in range(5)]}),
        ("over-pilot-cap", {"active_servers": [server(name="a%d" % i) for i in range(6)],
                            "candidate_servers": [server(name="c%d" % i) for i in range(7)]}),
        ("empty", {}),
    ]
    return {
        "activations": [{"label": label, "server": srv, "profile": profile,
                         "result": mcp.validate_activation(srv, profile)}
                        for label, srv, profile in activations],
        "profiles": [{"label": label, "profile": profile, "result": mcp.validate_profile(profile)}
                     for label, profile in profiles],
    }


def registry_cases(reg):
    catalog = [{"id": "tdd"}, {"id": "git-worktrees"}, {"id": "ops-runbook"}, "not-a-dict"]
    sets = [
        ("consistent", {"catalog": catalog, "profile": ["tdd"], "lock": {"tdd": "abc"}}),
        ("missing-from-catalog", {"catalog": catalog, "profile": ["ghost"], "lock": {"ghost": "1"}}),
        ("missing-from-lock", {"catalog": catalog, "profile": ["tdd", "ops-runbook"], "lock": {"tdd": "1"}}),
        ("unselected-pin", {"catalog": catalog, "profile": [], "lock": {"z": "1", "a": "2"}}),
        ("unknown-keys", {"catalog": [], "profile": [], "lock": {}, "zeta": 1, "alpha": 2}),
        ("catalog-not-list", {"catalog": {}, "profile": [], "lock": {}}),
        ("profile-not-list", {"catalog": [], "profile": "tdd", "lock": {}}),
        ("lock-not-dict", {"catalog": [], "profile": [], "lock": []}),
        ("not-a-mapping", ["catalog"]),
        ("int-selection", {"catalog": [{"id": "5"}], "profile": [5], "lock": {"5": "x"}}),
        ("astral-unknown-keys", {"catalog": [], "profile": [], "lock": {},
                                 "\U0001f600": 1, "\uffff": 2, "\u00e9": 3}),
        ("astral-lock-unselected", {"catalog": [{"id": "\U0001f600"}, {"id": "\uffff"},
                                                 {"id": "b"}],
                                    "profile": ["b"],
                                    "lock": {"\U0001f600": "1", "\uffff": "2", "b": "3"}}),
        ("astral-missing-from-lock", {"catalog": [{"id": "\U0001f600"}, {"id": "\uffff"}],
                                      "profile": ["\U0001f600", "\uffff"], "lock": {}}),
    ]
    capabilities = [
        ("all-declared", {"edition": ["skills", "mcp"]}, ["skills", "mcp", "hooks"]),
        ("unknown", {"flags": ["skills", "telepathy"], "edition": "mcp"}, ["skills"]),
        ("dict-registry", {"edition": "skills"}, {"skills": {}, "mcp": {}}),
        ("int-capability", {"edition": [7]}, ["7"]),
        ("not-a-mapping", ["skills"], ["skills"]),
        ("astral-flag-keys", {"\U0001f600": ["cap"], "\uffff": ["cap"], "skills": ["skills"]},
         ["skills"]),
    ]
    reserved = [
        ("clean", {"project": {}, "commands": {}}),
        ("adapters", {"adapters": {}}),
        ("both", {"profile": "x", "adapters": []}),
        ("not-a-mapping", "profile"),
    ]
    supply = [
        ("clean", ["docs/ops/stage63-adoption-lib.mjs", ".claude/hooks/session-start.sh"]),
        ("adapter", ["extensions/adapters/claude.py", "README.md"]),
        ("supply-and-contract", ["extensions/supply/x.json", "Canonical/sibling-contract.json"]),
        ("int-path", [5]),
        ("not-a-list", "extensions/adapters/x"),
    ]
    return {
        "sets": [{"label": l, "record": r, "violations": reg.check_registry_set(r)} for l, r in sets],
        "capabilities": [{"label": l, "selection": s, "registry": g,
                          "violations": reg.check_capability_exists(s, g)} for l, s, g in capabilities],
        "reserved": [{"label": l, "config": c, "violations": reg.check_reserved_keys(c)} for l, c in reserved],
        "supply": [{"label": l, "files": f, "violations": reg.check_supply_boundary(f)} for l, f in supply],
    }


def descriptor(slug, name, description, tokens, deps=()):
    return {
        "name": name, "semantic_id": "capability.%s" % slug, "description": description,
        "body_bytes": tokens * 4, "body_tokens_est": tokens, "dependencies": list(deps),
        "body_digest": "sha256:%s" % slug, "source_path": "skills/%s/SKILL.md" % slug,
    }


def compiler_cases(pc):
    catalog = [
        descriptor("tdd", "test-driven-development", "RED then GREEN process", 900,
                   ["capability.git-worktrees", "references"]),
        descriptor("git-worktrees", "using-git-worktrees", "isolated worktree process", 300),
        descriptor("ops-runbook", "ops runbook", "operate the platform", 700),
        descriptor("ops-deploy", "ops deploy", "deploy the platform", 600, ["ops-runbook"]),
        descriptor("loop-a", "loop a", "first half of a cycle", 10, ["loop-b"]),
        descriptor("loop-b", "loop b", "second half of a cycle", 10, ["capability.loop-a"]),
    ]
    descriptors = [
        ("valid", catalog[0]),
        ("missing-fields", {"name": "x"}),
        ("blank-strings", dict(catalog[1], name="  ", body_digest=None)),
        ("negative-int", dict(catalog[1], body_bytes=-1)),
        ("bool-int", dict(catalog[1], body_tokens_est=True)),
        ("deps-not-list", dict(catalog[1], dependencies="tdd")),
        ("bad-semantic-id", dict(catalog[1], semantic_id="skill.tdd")),
    ]
    for name, pad in _S5.PADS:
        descriptors.append(("pad-name-" + name, dict(catalog[1], name=pad)))
        descriptors.append(("pad-description-" + name, dict(catalog[1], description=pad)))
        descriptors.append(("pad-name-text-" + name, dict(catalog[1], name=pad + "x" + pad)))
    selections = [
        ("semantic-id", ["capability.git-worktrees"], None, "claude"),
        ("slug-with-dependencies", ["tdd"], None, "claude"),
        ("keyword-unique", ["deploy"], None, "codex"),
        ("keyword-ambiguous", ["ops"], None, "claude"),
        ("absent", ["telepathy"], None, "claude"),
        ("three-top-level", ["tdd", "ops-runbook", "loop-a"], None, "claude"),
        ("process-plus-domain", ["tdd", "ops-deploy"], None, "antigravity"),
        ("duplicate-request", ["tdd", "capability.tdd"], None, "claude"),
        ("cycle", ["loop-a"], None, "claude"),
        ("over-budget", ["tdd"], 1000, "claude"),
        ("within-budget", ["tdd"], 1200, "claude"),
        ("int-request", [5], None, "claude"),
        ("empty-request", [], None, "local"),
    ]

    def compile_case(label, requests, budget, provider, entries=catalog):
        try:
            result = pc.select_candidates(entries, requests, budget_tokens=budget, provider=provider)
        except ValueError as error:
            return {"label": label, "requests": requests, "budget": budget, "provider": provider,
                    "descriptors": entries, "error": str(error)}
        out = {"label": label, "requests": requests, "budget": budget, "provider": provider,
               "selected": result.selected, "findings": result.findings,
               "discovery_tokens": result.discovery_tokens, "body_tokens_est": result.body_tokens_est,
               "ok": result.ok}
        if entries is not catalog:
            out["descriptors"] = entries
        return out

    compiled = [compile_case(*case) for case in selections]
    compiled.append(compile_case("duplicate-index", ["tdd"], None, "claude", catalog + [catalog[0]]))
    # Ambiguous keyword over ids that mix BMP, U+FFFF and astral characters: Python sorts by
    # code point, so the candidate list is bmp, U+FFFF, U+1F600.
    astral = [
        descriptor("bmp", "shared bmp", "shared keyword", 10),
        descriptor("\uffff", "shared fffd", "shared keyword", 10),
        descriptor("\U0001f600", "shared astral", "shared keyword", 10),
    ]
    compiled.append(compile_case("astral-ambiguous", ["shared"], None, "claude", astral))
    compiled.append(compile_case("astral-unique-slug", ["\uffff"], None, "claude", astral))
    return {
        "catalog": catalog,
        "descriptors": [{"label": l, "record": r, "repairs": pc.validate_descriptor(r)}
                        for l, r in descriptors],
        "selections": compiled,
    }


def render(golden):
    """Sections of cases, one case per line (same layout as the S5 golden)."""
    def dumps(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    def block(cases):
        return "[\n" + ",\n".join("   " + dumps(case) for case in cases) + "\n  ]"

    lines = ['"_generator":%s' % dumps(golden["_generator"]),
             '"_provenance":%s' % dumps(golden["_provenance"])]
    for section in ("mcp", "registry", "compiler"):
        parts = []
        for key in sorted(golden[section]):
            value = golden[section][key]
            parts.append('"%s":%s' % (key, block(value) if isinstance(value, list) and key != "catalog"
                                      else dumps(value)))
        lines.append('"%s":{\n  %s\n }' % (section, ",\n  ".join(parts)))
    return "{\n " + ",\n ".join(lines) + "\n}\n"


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    mcp, reg, pc = (_S5.load(sys.argv[1], name) for name in MODULES)
    golden = {
        "_provenance": "agent-engineering-standard @ %s: tools/%s.py" % (
            SHA, ".py + tools/".join(MODULES)),
        "_generator": "docs/ops/stage63-profiles-golden.py",
        "mcp": mcp_cases(mcp),
        "registry": registry_cases(reg),
        "compiler": compiler_cases(pc),
    }
    sys.stdout.write(render(golden))


if __name__ == "__main__":
    main()
