// node --test docs/ops/stage63-release.test.mjs (run from the repo root)
//
// S10 (slice S10, #428): the release/runtime contract. Three upstream Stage
// modules are characterized against golden Python output loaded from the
// pinned Standard commit: release_mold (Stage 61a, the release verdicts),
// proof_invalidation (Stage 33, frozen molds with proof invalidation) and
// edition_packaging (T10, the Full/Lite release VERIFY contract). Every frozen
// corpus is embedded in the golden, so the replay needs no checkout.
//
// The 61b release proofbed already pins the 14 release rule names
// (stage61b-release-proofbed-lib.mjs); this file ports the evaluation logic
// that binding did not carry, and pins both sides to the same table.
//
// Not ported, by design: tools/standardctl.py's edition UX (--edition,
// --set harness.*, doctor --live). hyperbolic-core has no edition or harness
// surface for it to drive, so it would be dead code with no ADOPTION row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const golden = JSON.parse(read("docs/ops/stage63-release-golden.json"));
const SHA = "516fdb25d091f2f3f467fb48eaee01cb7f805c88";

// The golden records a corpus validator's entry count, not the entries.
const corpusCounts = ({ findings, entries }) => ({ findings, entries: entries.length });

// Run one port call; a thrown error becomes {error: <Python exception name>}.
const replay = (call) => {
  try {
    return call();
  } catch (error) {
    return { error: error.name };
  }
};

test("S10 · golden is pinned to the new Standard SHA and names its three modules", () => {
  assert.match(golden._provenance, new RegExp(SHA));
  for (const mod of ["release_mold", "proof_invalidation", "edition_packaging"]) {
    assert.match(golden._provenance, new RegExp(`tools/${mod}\\.py`));
  }
  assert.equal(golden._python, "3.12");
});

// --- release_mold: contract tables and evaluate --------------------------------

test("S10 · release_mold frozen tables match the Stage 61a oracle", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  assert.deepEqual([...lib.RELEASE_VERDICTS], ["PROMOTE", "HOLD", "REFUSE"]);
  assert.deepEqual([...lib.RELEASE_CLAIMS], [
    "integrated-behavior", "deployment-proof", "rollback-proof", "restore-proof",
    "provenance-proof", "runtime-proof", "canary-proof",
  ]);
  assert.deepEqual([...lib.RELEASE_RULES], [
    "open-issues", "stale-artifact", "broken-integration", "failed-rollback",
    "unusable-backup", "missing-attestation", "invariant-breach", "missing-telemetry",
    "partial-green", "expired-evidence", "restore-rpo", "mold-unqualified",
    "canary-missing", "clean-promote",
  ]);
  assert.deepEqual({ ...lib.RELEASE_RULE_VERDICTS }, {
    "open-issues": "REFUSE", "stale-artifact": "REFUSE", "broken-integration": "REFUSE",
    "failed-rollback": "REFUSE", "unusable-backup": "REFUSE", "missing-attestation": "REFUSE",
    "invariant-breach": "REFUSE", "missing-telemetry": "REFUSE", "partial-green": "REFUSE",
    "expired-evidence": "REFUSE", "restore-rpo": "PROMOTE", "mold-unqualified": "HOLD",
    "canary-missing": "HOLD", "clean-promote": "PROMOTE",
  });
  assert.deepEqual([...lib.RELEASE_SEVERITIES], ["blocker", "major", "minor"]);
  assert.deepEqual([...lib.RELEASE_FINDING_FIELDS], ["id", "rule", "finding", "severity", "excerpt"]);
});

test("S10 · release_mold agrees with the 61b proofbed binding on every rule and verdict", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  const proofbed = await import("./stage61b-release-proofbed-lib.mjs");
  assert.deepEqual([...lib.RELEASE_RULES], [...proofbed.FROZEN_RULES]);
  assert.deepEqual([...lib.RELEASE_CLAIMS], [...proofbed.FROZEN_CLAIMS]);
  assert.deepEqual([...lib.RELEASE_VERDICTS], [...proofbed.FROZEN_VERDICTS]);
  assert.deepEqual({ ...lib.RELEASE_RULE_VERDICTS }, { ...proofbed.RULE_VERDICTS });
});

test("S10 · every upstream release_mold golden case replays identically", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  assert.ok(golden.release.length >= 80, "the release golden covers the rule tree and inputs");
  for (const entry of golden.release) {
    assert.deepEqual(replay(() => lib.evaluateRelease(entry.input)), entry.output, entry.id);
  }
});

test("S10 · release_mold finding validation and corpus validation replay identically", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  for (const entry of golden.release_validators) {
    if (entry.id.startsWith("finding:")) {
      assert.deepEqual(replay(() => lib.releaseFindingRepairs(entry.input)), entry.output, entry.id);
    } else {
      assert.deepEqual(replay(() => corpusCounts(lib.validateReleaseCorpus(entry.input))), entry.output, entry.id);
    }
  }
});

test("S10 · the embedded release corpus is a valid frozen oracle that covers all 14 rules", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  const corpus = golden.release_validators.find((e) => e.id === "corpus:frozen").input;
  const { findings, entries } = lib.validateReleaseCorpus(corpus);
  assert.deepEqual(findings, []);
  assert.deepEqual(new Set(entries.map((e) => e.expected_rule)), new Set(lib.RELEASE_RULES));
});

test("S10 · the clean release package promotes through the proven restore (restore-rpo)", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  const decision = lib.evaluateRelease(lib.cleanReleasePackage());
  assert.equal(decision.verdict, "PROMOTE");
  assert.equal(decision.rule, "restore-rpo", "restore-rpo is checked before clean-promote");
  assert.equal(decision.findings[0].severity, "minor");
});

test("S10 · without a proven restore, a complete package promotes through clean-promote", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  const decision = lib.evaluateRelease({ ...lib.cleanReleasePackage(), restore_rpo_ok: false });
  assert.equal(decision.verdict, "PROMOTE");
  assert.equal(decision.rule, "clean-promote");
});

// --- proof_invalidation: freeze, classify and check ----------------------------

test("S10 · proof_invalidation frozen tables match the Stage 33 oracle", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  assert.deepEqual([...lib.INVALIDATION_RULES], [
    "mold-payload-changed", "intent-changed", "command-changed", "protected-path-touched",
    "stale-proof-reuse", "stale-review-reuse", "reopen-without-requalification",
  ]);
  assert.deepEqual([...lib.INVALIDATION_CHANGE_CLASSES], ["editorial", "semantic", "reopen"]);
  assert.deepEqual([...lib.FREEZE_FIELDS], [
    "mold", "frozen_digest", "frozen_head", "frozen_intent_digest", "frozen_commands", "frozen_by",
  ]);
  assert.equal(lib.FROZEN_BY, "proof_invalidation.freeze");
});

test("S10 · every upstream proof_invalidation golden case replays identically", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  assert.ok(golden.invalidation.length >= 60, "the invalidation golden covers every rule path");
  for (const entry of golden.invalidation) {
    if (entry.id.startsWith("freeze:")) {
      const [mold, moldDigest, head, intentDigest, commands, provider] = entry.input;
      const call = () => lib.freeze(mold, moldDigest, head, intentDigest, commands, provider);
      assert.deepEqual(replay(call), entry.output, entry.id);
    } else {
      const call = () => {
        const result = lib.checkInvalidation(entry.input);
        return {
          change_class: result.change_class,
          findings: result.findings,
          invalidated: result.invalidated,
          classify: lib.classifyChange(entry.input),
        };
      };
      assert.deepEqual(replay(call), entry.output, entry.id);
    }
  }
});

test("S10 · proof_invalidation finding and corpus validation replay identically", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  for (const entry of golden.invalidation_validators) {
    if (entry.id.startsWith("finding:")) {
      assert.deepEqual(replay(() => lib.invalidationFindingRepairs(entry.input)), entry.output, entry.id);
    } else {
      assert.deepEqual(replay(() => corpusCounts(lib.validateInvalidationCorpus(entry.input))),
        entry.output, entry.id);
    }
  }
});

test("S10 · the embedded invalidation corpus is a valid frozen oracle covering all 7 rules", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  const corpus = golden.invalidation_validators.find((e) => e.id === "corpus:frozen").input;
  const { findings, entries } = lib.validateInvalidationCorpus(corpus);
  assert.deepEqual(findings, []);
  const covered = new Set(entries.flatMap((e) => e.expected_rules));
  assert.deepEqual([...covered].sort(), [...lib.INVALIDATION_RULES].sort());
});

// --- edition_packaging: Full/Lite contract checks ------------------------------

test("S10 · edition_packaging lite sets match the Standard EDITION_LITE_OFF oracle", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  assert.deepEqual([...lib.EDITION_LITE_OFF], ["llm_review_strict", "extensions_catalog"]);
  assert.deepEqual([...lib.EDITION_LITE_REQUIRED], [
    "check_template_pairs", "check_harness_edition", "check_gate_aggregator", "check_gate_noop_stages",
  ]);
  assert.deepEqual([...lib.EDITION_LITE_FORBIDDEN], [
    "check_review_always_comments", "check_no_native_review_gating", "check_capability_registry",
  ]);
});

test("S10 · every upstream edition_packaging golden case replays identically", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  assert.ok(golden.edition.length >= 50, "the edition golden covers every check and target");
  for (const entry of golden.edition) {
    if (entry.id.startsWith("constant:")) {
      const expected = entry.id.endsWith("lite-required")
        ? lib.EDITION_LITE_REQUIRED : lib.EDITION_LITE_OFF;
      assert.deepEqual([...expected], entry.output, entry.id);
    } else if (entry.id.startsWith("corpus:")) {
      assert.deepEqual(replay(() => lib.editionViolations(entry.input.target,
        entry.input.record, entry.input.known)), entry.output, entry.id);
    } else {
      const { target, record, known } = entry.input;
      assert.deepEqual(replay(() => lib.editionViolations(target, record, known)),
        entry.output, entry.id);
    }
  }
});

test("S10 · edition_packaging corpus validation replays identically", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  for (const entry of golden.edition_validators) {
    const { findings, entries } = lib.validateEditionCorpus(entry.input);
    assert.deepEqual({ findings, entries: entries.length }, entry.output, entry.id);
  }
});

test("S10 · the embedded edition corpus is a valid frozen oracle", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  const corpus = golden.edition_validators.find((e) => e.id === "corpus:frozen").input;
  assert.deepEqual(lib.validateEditionCorpus(corpus).findings, []);
});

// --- live binding: the proof_invalidation rules bind to this repo's own files ---

test("S10 · a freeze over this slice's own files invalidates when a protected file moves", async () => {
  const lib = await import("./stage63-release-lib.mjs");
  const protectedPath = "docs/ops/stage63-release-lib.mjs";
  assert.ok(existsSync(path.join(root, protectedPath)), "the protected lib is on disk");
  const run = {
    mold: "stage63-release", mold_digest: "a", frozen_digest: "a", frozen_head: "h",
    head: "h", intent_digest: "i", frozen_intent_digest: "i", commands: [], frozen_commands: [],
    proof: { verdict: "PASS" }, protected_paths: [protectedPath], touched_paths: [],
  };
  assert.equal(lib.checkInvalidation(run).invalidated, false, "an untouched freeze still binds");
  const touched = lib.checkInvalidation({ ...run, touched_paths: [protectedPath] });
  assert.equal(touched.change_class, "semantic");
  assert.ok(touched.findings.some((f) => f.rule === "protected-path-touched"));
  assert.ok(touched.findings.some((f) => f.rule === "stale-proof-reuse"));
});

// --- honesty: the three ports are reachable from the ADOPTION map --------------

test("S10 · the release/runtime mechanisms exist on disk", () => {
  for (const rel of [
    "docs/ops/stage63-release-lib.mjs", "docs/ops/stage63-release-golden.py",
    "docs/ops/stage63-release-golden.json", "docs/ops/stage63-release.test.mjs",
  ]) {
    assert.ok(existsSync(path.join(root, rel)), `${rel} is missing`);
  }
});
