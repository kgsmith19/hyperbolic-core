// node --test docs/ops/stage3c-settings-readback.test.mjs (run from the repo root)
//
// Stage 3c (#387): live GitHub settings/rulesets match the owner-approved
// squash-only, exact-head, one-Gate policy — proven by read-back.
//
// Two halves in one CI-provable file:
//   1. Characterization fixtures: each drift mode reproduces as a pure
//      predicate over a settings snapshot (no network).
//   2. Adapter proof: the recorded live ruleset response
//      (stage3c-live-ruleset-20904976.json, captured via `gh api`, never a
//      write response) maps through snapshotFromRuleset() to a clean
//      snapshot, and the adapter fails closed when a protective rule is
//      absent. The same adapter is what the live re-read script uses:
//      node docs/ops/stage3c-settings-readback-live.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVED, clean, drift, snapshotFromRuleset } from "./stage3c-settings-readback-lib.mjs";

function liveRuleset() {
  return JSON.parse(
    readFileSync(new URL("./stage3c-live-ruleset-20904976.json", import.meta.url), "utf8"),
  );
}

test("clean snapshot: no drift", () => {
  assert.deepEqual(drift(clean()), []);
});

test("wrong merge mode fires", () => {
  assert.ok(drift({ ...clean(), mergeMethods: ["squash", "merge"] }).includes("wrong-merge-mode"));
});

test("stale/wrong required context fires", () => {
  assert.ok(drift({ ...clean(), contexts: ["CI"] }).includes("stale-required-context"));
  assert.ok(drift({ ...clean(), contexts: ["PR Gate", "CI"] }).includes("wrong-required-context"));
});

test("non-strict protection fires", () => {
  assert.ok(drift({ ...clean(), strict: false }).includes("non-strict-protection"));
});

test("native approval drift fires", () => {
  assert.ok(drift({ ...clean(), approvals: 2 }).includes("native-approval-drift"));
});

test("force/delete exposure fires", () => {
  assert.ok(drift({ ...clean(), allowForce: true }).includes("force-delete-exposure"));
});

test("missing owner bypass fires", () => {
  assert.ok(drift({ ...clean(), bypass: [] }).includes("missing-owner-bypass"));
});

test("gate rename fires", () => {
  assert.ok(drift({ ...clean(), gateName: "CI" }).includes("gate-renamed"));
});

// --- Adapter proof: the recorded live API response is machine-verifiable ---

test("recorded live ruleset 20904976 maps to a clean, drift-free snapshot", () => {
  const snapshot = snapshotFromRuleset(liveRuleset());
  assert.deepEqual(snapshot, clean());
  assert.deepEqual(drift(snapshot), []);
});

test("adapter fails closed when the non_fast_forward rule is absent", () => {
  const ruleset = liveRuleset();
  const mutated = { ...ruleset, rules: ruleset.rules.filter((r) => r.type !== "non_fast_forward") };
  assert.ok(drift(snapshotFromRuleset(mutated)).includes("force-delete-exposure"));
});

test("adapter fails closed when the deletion rule is absent", () => {
  const ruleset = liveRuleset();
  const mutated = { ...ruleset, rules: ruleset.rules.filter((r) => r.type !== "deletion") };
  assert.ok(drift(snapshotFromRuleset(mutated)).includes("force-delete-exposure"));
});

test("adapter fails closed when the required-status rule is absent", () => {
  const ruleset = liveRuleset();
  const mutated = { ...ruleset, rules: ruleset.rules.filter((r) => r.type !== "required_status_checks") };
  assert.ok(drift(snapshotFromRuleset(mutated)).includes("stale-required-context"));
});
