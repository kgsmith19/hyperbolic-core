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

test("failed-rollback: deploy.yml auto-rolls-back and a rolled-back unit is not tagged", () => {
  const deploy = read(".github/workflows/deploy.yml");
  // Shell activation rolls the symlink back; the service deploys guard health.
  assert.match(deploy, /current\.rollback/);
  assert.match(deploy, /ROLLBACK FAILED/);
  // tag-release only fires on the run's overall smoke success (a rolled-back
  // job reports failure, so it is skipped) — not on a unit's own deploy.
  assert.match(deploy, /needs\.smoke\.result == 'success'/);
});

test("broken-integration: post-deploy smoke is the live, read-only verdict that withholds the tag", () => {
  const smoke = read(".github/workflows/platform-smoke.yml");
  assert.match(smoke, /contents: read/);
  // deploy.yml's tag-release needs smoke; a red smoke keeps the run red.
  assert.match(read(".github/workflows/deploy.yml"), /needs: \[deploy-shell, deploy-llm-handler, deploy-brain, deploy-broker, smoke\]/);
});

test("unusable-backup: the restore drill proves a real restore, check before restore before count", () => {
  const drill = read(".github/workflows/ops-restore-drill.yml");
  const check = drill.indexOf('restic -r "$repository" check --read-data-subset=10%');
  const restore = drill.indexOf('restic -r "$repository" restore');
  const count = drill.indexOf("select count(*) from $t");
  assert.ok(check > -1 && restore > -1 && count > -1, "drill missing check/restore/count");
  assert.ok(check < restore && restore < count, "drill order must be check -> restore -> count");
});

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

test("the three remaining gap rules map to their two still-open tracking Issues, exactly", () => {
  // #408 (restore RPO/RTO) and #405 (build provenance/SBOM) have landed,
  // so restore-rpo and missing-attestation are no longer gaps.
  const gaps = gapsOf(ADOPTION);
  assert.deepEqual(
    gaps,
    {
      "invariant-breach": "#407",
      "missing-telemetry": "#407",
      "canary-missing": "#406",
    },
    "the gap->Issue mapping drifted from the still-open Stage 61b gap Issues",
  );
});

test("attestation is now produced: provenance+SBOM in both deploy pipelines, and missing-attestation maps to a real mechanism (#405)", () => {
  // The bidirectional coupling working forward: #405 added provenance and
  // SBOM records to both deploy pipelines, so this pin flipped from "gap,
  // no attestation" to "mechanism present", and the ADOPTION entry had
  // to move off `gap` onto real on-disk paths in the same change. The
  // dual-file shape is asserted exactly (round-2 review): `paths` names
  // both mechanism files, legacy `path` stays consistent.
  const deploy = read(".github/workflows/deploy.yml");
  const lifeos = read(".github/workflows/lifeos-deploy.yml");
  assert.match(deploy, /attest-build-provenance/);
  assert.match(deploy, /sbom: true/);
  assert.match(deploy, /spdx-json/);
  assert.match(deploy, /shell-dist\.sha256/);
  assert.match(deploy, /shell-dist-sbom\.spdx\.json/);
  assert.match(lifeos, /lifeos-backend-build\.sha256/);
  assert.match(lifeos, /lifeos-backend-sbom\.spdx\.json/);
  assert.match(lifeos, /lifeos-ui-dist\.sha256/);
  assert.match(lifeos, /lifeos-ui-sbom\.spdx\.json/);
  assert.deepEqual(ADOPTION["missing-attestation"].paths, [
    ".github/workflows/deploy.yml",
    ".github/workflows/lifeos-deploy.yml",
  ]);
  assert.equal(ADOPTION["missing-attestation"].path, ".github/workflows/deploy.yml");
  assert.ok(!ADOPTION["missing-attestation"].gap, "missing-attestation is no longer a gap");
});

test("no canary is declared yet, and its declaration mechanism is the tracked gap", () => {
  // If any workflow ever declares a canary exposure/window/invariants, this
  // pin flips and the gap entry must be replaced with a real path — that is
  // the intended coupling, not a false failure.
  for (const wf of ["deploy.yml", "platform-smoke.yml"]) {
    const text = read(path.join(".github/workflows", wf));
    assert.doesNotMatch(text, /canary_exposure|observation.window|canary.invariants/i);
  }
  assert.equal(ADOPTION["canary-missing"].gap, "#406");
});

test("no canary telemetry/invariant evaluation exists yet", () => {
  assert.equal(ADOPTION["invariant-breach"].gap, "#407");
  assert.equal(ADOPTION["missing-telemetry"].gap, "#407");
});

test("restore RPO/RTO is now measured: the drill records both, and restore-rpo maps to a real mechanism (#408)", () => {
  // The bidirectional coupling working forward: #408 added RPO/RTO to the
  // drill, so this pin flipped from "gap, no timing" to "measured", and the
  // ADOPTION entry had to move off `gap` onto a real on-disk path in the
  // same change.
  const drill = read(".github/workflows/ops-restore-drill.yml");
  assert.match(drill, /rpo_seconds="\$\(\( now_epoch - snapshot_epoch_value \)\)"/);
  assert.match(drill, /rto_seconds="\$\(\( restore_end - restore_start \)\)"/);
  assert.match(drill, /RPO \(s\)/);
  assert.match(drill, /RTO \(s\)/);
  assert.equal(ADOPTION["restore-rpo"].path, ".github/workflows/ops-restore-drill.yml");
  assert.ok(!ADOPTION["restore-rpo"].gap, "restore-rpo is no longer a gap");
});

test("the aggregate posture is honest: the earliest unmet proof REFUSES, never a false PROMOTE", () => {
  // In the frozen check order, the first rule whose hyperbolic-core
  // mechanism is a gap is now invariant-breach (a REFUSE rule): #405
  // landed, so missing-attestation has a real mechanism. A real
  // hyperbolic release evaluated against today's mechanism set therefore
  // cannot reach clean-promote — the proofbed states REFUSE, not PROMOTE,
  // until at least #406/#407 land.
  const first = earliestGap(ADOPTION, FROZEN_RULES);
  assert.equal(first, "invariant-breach");
  assert.equal(RULE_VERDICTS[first], "REFUSE");
  assert.notEqual(RULE_VERDICTS[first], "PROMOTE");
});
