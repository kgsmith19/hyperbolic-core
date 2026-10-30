// node --test docs/ops/stage61b-release-proofbed.test.mjs (run from the repo root)
//
// Runtime basis: identical to stage59b-review-adoption.test.mjs — the .mjs
// imports run natively under Node's built-in test runner (CI pins
// node-version "22.19.0" in .github/actions/verify-tests-shell, and the
// Platform lane executes exactly this file via `node --test
// docs/ops/*.test.mjs`). No loader, transpiler, or dist build is involved —
// proven by the green Platform run on the PR, not by assertion.
//
// Stage 61b (#390): hyperbolic-core's runtime proofbed slice. It binds the
// frozen Stage 61a Release Mold contract (agent-engineering-standard
// tools/release_mold.py @ 8b7847d, merge of #266) to the hyperbolic-core
// runtime mechanisms that satisfy each release rule — and HONESTLY discloses
// the mechanisms that do not exist yet as gaps tracked in their own Issues
// (#405 attestation, #406 canary declaration, #407 canary telemetry, #408
// restore RPO/RTO), rather than claiming a proof that is not there.
//
// Three halves in one CI-provable file:
//   1. Contract fidelity + mapping totality: the transcribed 61a contract
//      matches its frozen shape, and every one of the 14 rules maps to
//      exactly one hyperbolic-core mechanism (a real on-disk path) or one
//      gap Issue.
//   2. Behavioral pins: the mapped REAL mechanisms (rollback, smoke-gated
//      tagging, restore drill, PR Gate rollup, exact-head evidence) are
//      pinned against the actual workflow topology.
//   3. Honesty pins: each disclosed gap's mechanism genuinely does NOT
//      exist yet, and the aggregate release posture is REFUSE/HOLD (never a
//      false PROMOTE) while the gaps are open — the proofbed must not commit
//      the green-washing sin the Mold polices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADOPTION,
  FROZEN_RULES,
  FROZEN_CLAIMS,
  FROZEN_VERDICTS,
  RULE_VERDICTS,
  GAP_ISSUES,
  gapsOf,
  earliestGap,
} from "./stage61b-release-proofbed-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

// --- Half 1: contract fidelity + total, grounded mapping ---

test("the frozen 61a contract is transcribed byte-stable: 3 verdicts, 7 claims, 14 rules in order", () => {
  assert.deepEqual(FROZEN_VERDICTS, ["PROMOTE", "HOLD", "REFUSE"]);
  assert.deepEqual(FROZEN_CLAIMS, [
    "integrated-behavior",
    "deployment-proof",
    "rollback-proof",
    "restore-proof",
    "provenance-proof",
    "runtime-proof",
    "canary-proof",
  ]);
  assert.deepEqual(FROZEN_RULES, [
    "open-issues",
    "stale-artifact",
    "broken-integration",
    "failed-rollback",
    "unusable-backup",
    "missing-attestation",
    "invariant-breach",
    "missing-telemetry",
    "partial-green",
    "expired-evidence",
    "restore-rpo",
    "mold-unqualified",
    "canary-missing",
    "clean-promote",
  ]);
  assert.equal(FROZEN_RULES.length, 14);
});

test("every rule carries a frozen verdict in {PROMOTE, HOLD, REFUSE}", () => {
  for (const rule of FROZEN_RULES) {
    assert.ok(FROZEN_VERDICTS.includes(RULE_VERDICTS[rule]), `rule ${rule} has no valid frozen verdict`);
  }
  // The frozen verdict of each rule, byte-stable with release_mold.py's RULE_VERDICTS.
  assert.equal(RULE_VERDICTS["open-issues"], "REFUSE");
  assert.equal(RULE_VERDICTS["restore-rpo"], "PROMOTE");
  assert.equal(RULE_VERDICTS["mold-unqualified"], "HOLD");
  assert.equal(RULE_VERDICTS["canary-missing"], "HOLD");
  assert.equal(RULE_VERDICTS["clean-promote"], "PROMOTE");
});

test("all 14 frozen rules are adopted exactly once", () => {
  assert.deepEqual(new Set(Object.keys(ADOPTION)), new Set(FROZEN_RULES));
  assert.equal(Object.keys(ADOPTION).length, 14);
});

test("every adopted rule names exactly one of {real mechanism, gap Issue} plus a note", () => {
  // Dual-file mechanisms carry `paths` (every file) alongside the legacy
  // single `path`; both must be present and consistent when `paths` exists.
  for (const [rule, entry] of Object.entries(ADOPTION)) {
    assert.ok(entry.note && entry.note.trim().length > 0, `rule ${rule} needs a note`);
    const hasPath = typeof entry.path === "string" && entry.path.length > 0;
    const hasGap = typeof entry.gap === "string" && entry.gap.length > 0;
    assert.ok(
      hasPath !== hasGap,
      `rule ${rule} must name exactly one of {path, gap}, not both/neither`,
    );
  }
});

test("every REAL mapped mechanism exists on disk", () => {
  for (const [rule, entry] of Object.entries(ADOPTION)) {
    // Dual-file mechanisms (missing-attestation spans deploy.yml +
    // lifeos-deploy.yml) list every file in `paths`; single-file entries
    // keep the legacy `path`.
    const files = entry.paths ?? (entry.path ? [entry.path] : []);
    for (const file of files) {
      assert.ok(
        existsSync(path.join(root, file)),
        `rule ${rule} names a missing mechanism: ${file}`,
      );
    }
    if (entry.paths) {
      assert.ok(
        entry.paths.includes(entry.path),
        `rule ${rule}: legacy path must be one of paths`,
      );
    }
  }
});

test("every gap names a real tracking Issue in the declared gap set", () => {
  for (const [rule, entry] of Object.entries(ADOPTION)) {
    if (!entry.gap) continue;
    assert.match(entry.gap, /^#\d+$/, `rule ${rule} gap must be a #NNN Issue reference`);
    assert.ok(GAP_ISSUES.includes(entry.gap), `rule ${rule} gap ${entry.gap} is not a declared Stage 61b gap Issue`);
  }
});

// --- Half 2: the mapped REAL mechanisms, pinned against the live topology ---

test("partial-green: PR Gate's verdict is its own needs.*.result, so a non-success lane cannot pass", () => {
  const verify = read(".github/workflows/pr-verify.yml");
  assert.match(
    verify,
    /needs: \[repository-standards, toolbelt, acc-linux, acc-windows, brain, platform, lifeos, ai-review\]/,
  );
  assert.match(verify, /needs\.\w/); // verdict computed from needs results
  // Exactly one required check in the ruleset spec.
  const required = (read("project.yaml").match(/^\s*required: true/mg) ?? []).length;
  assert.equal(required, 1);
});

test("open-issues: PR Gate fails closed on an open linked Issue with an unchecked checklist (Issue #274)", () => {
  const verify = read(".github/workflows/pr-verify.yml");
  assert.match(verify, /parseLinkedIssues/);
  assert.match(verify, /checklistBlocked/);
});

test("expired-evidence: verification binds to the exact head, so a stale verdict is never trusted", () => {
  const verify = read(".github/workflows/pr-verify.yml");
  assert.match(verify, /expectedHeadOid/);
  assert.ok(existsSync(path.join(root, ".github/workflows/llm-review-recheck.yml")));
});

test("mold-unqualified: this proofbed IS hyperbolic-core's built/attacked/qualified Release Mold", () => {
  // The proofbed file the mold-unqualified rule points at is this test plus
  // its lib; both must exist and the lib must carry the frozen-contract
  // provenance so the qualification is traceable, not asserted.
  assert.ok(existsSync(path.join(root, "docs/ops/stage61b-release-proofbed.test.mjs")));
  assert.ok(existsSync(path.join(root, "docs/ops/stage61b-release-proofbed-lib.mjs")));
  assert.match(read("docs/ops/stage61b-release-proofbed-lib.mjs"), /release_mold\.py @ 8b7847d/);
});

// --- Half 3: the disclosed gaps are real gaps, and the posture is honest ---

test("the cloud pipeline's rules are honest gaps tracked by #504 after its removal (#503)", () => {
  // Oracle change (#503): #405-#408 had mapped these rules to the cloud deploy
  // pipeline. The owner's local-only decision removed that pipeline, so each
  // is a declared gap again, never a silent claim, until #504 lands.
  // #504 (local release proof) moved five of these onto real paths:
  // ops/release.py (stale-artifact, broken-integration, failed-rollback) and
  // ops/store_ops.py (unusable-backup, restore-rpo). The four left are
  // honest gaps: no signed build manifest, invariant, telemetry or canary.
  assert.deepEqual(gapsOf(ADOPTION), Object.fromEntries([
    "missing-attestation", "invariant-breach", "missing-telemetry", "canary-missing",
  ].map((rule) => [rule, "#504"])));
  for (const rule of ["stale-artifact", "broken-integration", "failed-rollback", "unusable-backup", "restore-rpo"]) {
    assert.ok(ADOPTION[rule].path?.startsWith("ops/"), `${rule} must name a real local mechanism`);
  }
  assert.deepEqual(GAP_ISSUES, ["#504"]);
  for (const file of [
    ".github/workflows/deploy.yml",
    ".github/workflows/lifeos-deploy.yml",
    ".github/workflows/ops-restore-drill.yml",
    ".github/workflows/canary-observe.yml",
  ]) {
    assert.ok(!existsSync(path.join(root, file)), `${file} is back: move its rule off the gap`);
  }
});

test("the aggregate posture is honest: the first gap REFUSEs, so clean-promote is unreachable today", () => {
  const first = earliestGap(ADOPTION, FROZEN_RULES);
  assert.equal(first, "missing-attestation");
  assert.equal(RULE_VERDICTS[first], "REFUSE");
});
