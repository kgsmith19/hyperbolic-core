// node --test docs/ops/stage3c-settings-readback.test.mjs (run from the repo root)
//
// Stage 3c (#387): live GitHub settings/rulesets match the owner-approved
// squash-only, exact-head, one-Gate policy — proven by read-back.
//
// Characterization fixtures: each drift mode below reproduces as a pure
// predicate over a settings snapshot (no network), so CI proves the check
// fires without mutating live state. The live read-back log (recorded
// separately on the issue, values read via gh api, never trusted from a
// write response) is the second half of the proof.
import { test } from "node:test";
import assert from "node:assert/strict";

const APPROVED = {
  mergeMethods: ["squash"],
  requiredContext: "PR Gate",
  requiredApprovals: 0,
  ownerBypassId: 64936641,
  gateName: "PR Gate",
};

function drift(snapshot) {
  const findings = [];
  if (JSON.stringify([...snapshot.mergeMethods].sort()) !== JSON.stringify(APPROVED.mergeMethods))
    findings.push("wrong-merge-mode");
  if (!snapshot.contexts.includes(APPROVED.requiredContext))
    findings.push("stale-required-context");
  if (snapshot.contexts.some((c) => c !== APPROVED.requiredContext && !c.startsWith("PR Gate")))
    findings.push("wrong-required-context");
  if (!snapshot.strict) findings.push("non-strict-protection");
  if (snapshot.approvals !== APPROVED.requiredApprovals) findings.push("native-approval-drift");
  if (snapshot.allowForce || snapshot.allowDelete) findings.push("force-delete-exposure");
  if (!snapshot.bypass.includes(APPROVED.ownerBypassId)) findings.push("missing-owner-bypass");
  if (snapshot.gateName !== APPROVED.gateName) findings.push("gate-renamed");
  return findings;
}

function clean() {
  return {
    mergeMethods: ["squash"], contexts: ["PR Gate"], strict: true,
    approvals: 0, allowForce: false, allowDelete: false,
    bypass: [64936641], gateName: "PR Gate",
  };
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
