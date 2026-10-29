// node --test docs/ops/stage63-continuity.test.mjs (run from the repo root)
//
// S5 RED characterization (Issue #423): v5 continuity and context-rotation
// semantics from agent-engineering-standard @
// 1686e3b490380194cff78767b88c4e0288410e96 — tools/context_rotation.py
// (Stage 48), tools/context_budget.py (zero-compaction governor),
// tools/handoff_acceptance.py (Stage 45 HAT/SAT) and tools/capsule.py (the
// provider-neutral goal/scratch recovery packet).
//
// The independent oracle is stage63-continuity-golden.json: every case there
// was computed by the upstream Python itself, loaded from the pinned commit by
// stage63-continuity-golden.py. These ports are offline, pure
// characterization: no workflow, PR Gate, deployment, or production behavior
// consumes them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADOPTION, FROZEN, GAP_SLICES, acceptHandoff, buildCapsule, decideRotation,
  governBudget, provenance, pythonSemantics, renderCapsule, scanCapsule,
} from "./stage63-adoption-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const golden = JSON.parse(readFileSync(path.join(here, "stage63-continuity-golden.json"), "utf8"));

// --- Frozen contract shape ---------------------------------------------------

test("S5 · context_rotation sequence, verdicts, and rules are frozen", () => {
  assert.deepEqual([...FROZEN.context_rotation.SEQUENCE], [
    "checkpointed", "lease-handed", "capsule-written", "session-fresh", "accepted", "resumed",
  ]);
  assert.deepEqual([...FROZEN.context_rotation.VERDICTS], ["ROTATE", "HOLD", "FREEZE", "RECOVER"]);
  assert.deepEqual([...FROZEN.context_rotation.RULES], [
    "compacted", "polluted", "read-only-bound", "boundary-due", "imminent-compact",
    "overflow-output", "missing-checkpoint", "provider-switch", "canary-missing", "clean-rotate",
  ]);
  assert.deepEqual({ ...FROZEN.context_rotation.RULE_VERDICTS }, {
    compacted: "FREEZE", polluted: "RECOVER", "read-only-bound": "ROTATE",
    "boundary-due": "ROTATE", "imminent-compact": "ROTATE", "overflow-output": "ROTATE",
    "missing-checkpoint": "HOLD", "provider-switch": "ROTATE", "canary-missing": "HOLD",
    "clean-rotate": "ROTATE",
  });
  assert.deepEqual([...FROZEN.context_rotation.FINDING_FIELDS], [
    "id", "rule", "finding", "severity", "excerpt",
  ]);
});

test("S5 · capsule version, budget, and the 26 canonical fields are frozen", () => {
  assert.equal(FROZEN.capsule.VERSION, "5.0.0");
  assert.equal(FROZEN.capsule.BUDGET_BYTES_MIN, 16 * 1024);
  assert.equal(FROZEN.capsule.BUDGET_BYTES_MAX, 24 * 1024);
  assert.deepEqual([...FROZEN.capsule.CAPSULE_FIELDS], [
    "schema", "version", "issue", "outcome", "remaining_claims", "phase", "role", "risk",
    "focus_envelope", "allowed_paths", "protected_paths", "branch", "base", "head", "pr",
    "lease", "extensions", "rule_ids", "last_verification", "blocker", "next_action",
    "stop_conditions", "source_hashes", "redacted", "expires", "producer",
  ]);
  assert.equal(FROZEN.capsule.BUDGET_BYTES_MAX, FROZEN.context_budget.CAPSULE_BYTES_MAX,
    "capsule budget and governor capsule ceiling are one number upstream");
});

test("S5 · provenance names all four continuity modules at the pinned SHA", () => {
  for (const module of ["context_rotation", "context_budget", "handoff_acceptance", "capsule"]) {
    assert.match(provenance(), new RegExp(`tools/${module}\\.py`));
  }
  assert.match(provenance(), /1686e3b490380194cff78767b88c4e0288410e96/);
  assert.match(golden._provenance, /1686e3b490380194cff78767b88c4e0288410e96/);
});

test("S5 · the shared golden loader regenerates at standard.lock's commit, never a stale SHA", () => {
  // Every stage-63 generator loads upstream through this file's SHA (#492): a
  // stale constant would regenerate every golden at the old Standard commit.
  const lock = readFileSync(path.join(root, "standard.lock"), "utf8").match(/^commit: ([0-9a-f]{40})$/m);
  const generator = readFileSync(path.join(here, "stage63-continuity-golden.py"), "utf8").match(/^SHA = "([0-9a-f]{40})"$/m);
  assert.ok(lock && generator, "standard.lock commit or generator SHA not found");
  assert.equal(generator[1], lock[1]);
  // The goldens are the upstream Python's own output: each records the commit it
  // actually loaded, so a golden left at another SHA fails here too.
  const goldens = readdirSync(here).filter((name) => /^stage63-[a-z-]+-golden\.json$/.test(name));
  assert.equal(goldens.length, 8, "every stage-63 golden is checked");
  for (const name of goldens) {
    const recorded = JSON.parse(readFileSync(path.join(here, name), "utf8"))._provenance;
    assert.ok(typeof recorded === "string" && recorded.startsWith(`agent-engineering-standard @ ${lock[1]}: `),
      `${name} was not generated at standard.lock's commit`);
  }
});

// --- Differential characterization against the upstream Python ----------------

test("S5 · golden corpus covers every rule, status, and acceptance kind", () => {
  assert.deepEqual(new Set(golden.rotation.map((c) => c.rule)), new Set(FROZEN.context_rotation.RULES));
  assert.deepEqual(new Set(golden.budget.map((c) => c.result.status)), new Set(FROZEN.context_budget.STATUSES));
  const refused = golden.acceptance.flatMap((c) => c.findings.map((f) => f.rule));
  assert.deepEqual(new Set(refused), new Set(FROZEN.handoff_acceptance.RULES));
  assert.deepEqual(new Set(golden.acceptance.map((c) => c.kind)), new Set(["HAT", "SAT"]));
});

for (const c of golden.rotation) {
  test(`S5 · decideRotation matches upstream: ${c.label}`, () => {
    const decision = decideRotation(c.signal);
    assert.deepEqual(
      { verdict: decision.verdict, rule: decision.rule, findings: decision.findings },
      { verdict: c.verdict, rule: c.rule, findings: c.findings },
    );
  });
}

for (const c of golden.budget) {
  test(`S5 · governBudget matches upstream: ${c.label}`, () => {
    assert.deepEqual(governBudget(c.footprint, c.options), c.result);
  });
}

for (const c of golden.acceptance) {
  test(`S5 · acceptHandoff matches upstream: ${c.label}`, () => {
    const decision = acceptHandoff(c.attempt);
    assert.deepEqual(
      { accepted: decision.accepted, kind: decision.kind, findings: decision.findings },
      { accepted: c.accepted, kind: c.kind, findings: c.findings },
    );
  });
}

for (const c of golden.capsule.scans) {
  test(`S5 · scanCapsule matches upstream: ${c.label}`, () => {
    assert.deepEqual(scanCapsule(c.capsule), c.repairs);
  });
}

// The capsule regexes (CAPSULE_SECRET_RE, CAPSULE_ABSPATH_RE, CAPSULE_SESSION_RE) only run over
// json.dumps(..., ensure_ascii=True) output. Pin that shield: the scanned blob is ASCII-only and
// byte-equal to Python, so /i, \s and \w never see U+0131, U+017F, U+00A0 or U+3000 raw.
test("S5 · capsule regexes see only ASCII: ensure_ascii shields the case-fold, whitespace and word gaps", () => {
  assert.ok(golden.capsule.ascii.length >= 5, "the pin covers the non-ASCII capsule probes");
  for (const c of golden.capsule.ascii) {
    const blob = pythonSemantics.jsonDumps(c.value, { sortKeys: true });
    assert.match(blob, /^[\x00-\x7f]*$/u, `${c.label}: the scanned blob must be ASCII-only`);
    assert.equal(blob, c.blob, `${c.label}: the blob must match json.dumps(sort_keys=True)`);
  }
});

for (const c of golden.capsule.builds) {
  test(`S5 · buildCapsule/renderCapsule match upstream: ${c.label}`, () => {
    if (c.error !== undefined) {
      assert.throws(() => buildCapsule(c.fields), (error) => error.message === c.error);
      return;
    }
    const capsule = buildCapsule(c.fields);
    assert.deepEqual(capsule, c.capsule);
    assert.equal(renderCapsule(capsule), c.render);
  });
}

// --- Cold-resume canary --------------------------------------------------------
// A fresh session holds nothing but the rendered capsule and replayed state:
// it must earn write authority from the capsule alone, refuse a moved head,
// and never resume through a compaction.

test("S5 · cold-resume canary: capsule alone earns write authority, never through compaction", () => {
  const [{ fields }] = golden.capsule.builds.filter((c) => c.label === "valid");
  const rendered = renderCapsule(buildCapsule(fields));
  const resumed = JSON.parse(rendered); // the fresh session's only memory

  const budget = governBudget({ capsule: Buffer.byteLength(rendered), rules: 4096 }, { phase_change: true });
  assert.equal(budget.status, "ROTATE_AT_BOUNDARY", "a phase boundary mandates rotation");
  assert.equal(decideRotation({ transition: "mold-to-builder", boundary: true, checkpointed: true }).verdict,
    "ROTATE");

  const attempt = {
    role: resumed.role, risk: resumed.risk, stated_phase: resumed.phase, replayed_phase: "IMPLEMENT",
    stated_head: resumed.head, reconciled_head: "a".repeat(40), owner_decision_recorded: true,
    protected_paths: resumed.protected_paths, accepted_scope: [...resumed.protected_paths, ...resumed.allowed_paths],
    provider_guardrails: true, prompt_text: resumed.next_action,
    stated_rules: resumed.rule_ids, route_rules: ["handoff-acceptance", "context-rotation"],
  };
  assert.deepEqual(acceptHandoff(attempt), { accepted: true, kind: "HAT", findings: [] },
    "the capsule restates task, head, scope, and rules exactly");

  const moved = acceptHandoff({ ...attempt, reconciled_head: "b".repeat(40) });
  assert.equal(moved.accepted, false);
  assert.equal(moved.findings[0].rule, "stale-head", "a moved head is never resumed blind");

  const compacted = decideRotation({ checkpointed: true, compaction_done: true });
  assert.deepEqual([compacted.verdict, compacted.rule], ["FREEZE", "compacted"],
    "after compaction mutation freezes until state is re-proven");
});

// --- hyperbolic-core runtime binding --------------------------------------------

test("S5 · goal/scratch state stays local: hyperbolic-core ignores its scratch roots", () => {
  const ignored = readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/);
  for (const scratch of [".agent-runtime/", ".superpowers/"]) {
    assert.ok(ignored.includes(scratch), `${scratch} must stay gitignored (capsules are never committed)`);
  }
  assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /Recovery after restart or compaction/);
});

test("S5 · continuity rows are grounded, and S5 closes every continuity gap", () => {
  const s5 = [
    "continuity:goal-scratch", "continuity:handoff-acceptance",
    "continuity:context-budget", "continuity:rotation-decision",
  ];
  const continuity = Object.keys(ADOPTION).filter((key) => key.startsWith("continuity:"));
  assert.deepEqual(continuity.sort(), [...s5, "continuity:work-state"].sort(),
    "S5 contributes exactly four continuity rows next to S1's work-state row");
  for (const key of s5) {
    assert.deepEqual(ADOPTION[key], { mechanism: "docs/ops/stage63-continuity.test.mjs", gap: null },
      `${key} is bound to this characterization`);
  }
  for (const key of continuity) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null, `${key} must be mechanism XOR gap`);
    if (entry.mechanism !== null) assert.ok(existsSync(path.join(root, entry.mechanism)));
    else assert.ok(GAP_SLICES.includes(entry.gap));
  }
});
