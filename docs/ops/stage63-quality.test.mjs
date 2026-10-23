// node --test docs/ops/stage63-quality.test.mjs (run from the repo root)
//
// S4 RED characterization (Issue #422): implementation-quality semantics
// from agent-engineering-standard tools/quality_eval.py @
// 9e50c9c3518e5bed2ba93e194cb157a78ee0278d. This oracle is deliberately
// offline and pure: it characterizes advisory evaluation semantics without
// changing any PR Gate, workflow, deployment, or production behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("S4 · dimensions, severities, and finding fields are frozen", async () => {
  const { FROZEN, provenance } = await import("./stage63-adoption-lib.mjs");
  assert.deepEqual([...FROZEN.quality.DIMENSIONS], [
    "correctness", "charter", "quality", "plane", "dependency", "parsimony",
  ]);
  assert.deepEqual([...FROZEN.quality.SEVERITIES], ["blocker", "major", "minor"]);
  assert.deepEqual([...FROZEN.quality.FINDING_FIELDS], [
    "id", "rule", "finding", "severity", "excerpt",
  ]);
  assert.match(provenance(), /tools\/quality_eval\.py/);
  assert.match(provenance(), /9e50c9c3518e5bed2ba93e194cb157a78ee0278d/);
});

test("S4 · missing or partial input stays deterministic and defaults to incorrect", async () => {
  const { scoreQuality } = await import("./stage63-adoption-lib.mjs");
  for (const input of [undefined, null, {}, { id: "partial", correct: true }]) {
    const result = scoreQuality(input);
    assert.equal(typeof result.points, "number");
    assert.equal(typeof result.wins, "boolean");
    assert.ok(Array.isArray(result.findings));
  }
  assert.equal(scoreQuality(undefined).wins, false);
  assert.equal(scoreQuality({ id: "partial", correct: true }).points, 55,
    "four conformance defaults plus disagreement are charged deterministically");
});

test("S4 · incorrect code loses even when it is shorter", async () => {
  const { scoreQuality } = await import("./stage63-adoption-lib.mjs");
  const result = scoreQuality({
    id: "tiny-wrong", correct: false, charter_clean: true, quality_ok: true,
    plane_clean: true, dependency_ok: true, owned_loc: 1, reviewers_agree: true,
  });
  assert.equal(result.points, 0);
  assert.equal(result.wins, false);
  assert.deepEqual(result.findings.map(({ rule, severity }) => ({ rule, severity })), [
    { rule: "correctness", severity: "blocker" },
  ]);
});

test("S4 · each conformance miss costs ten, complexity is capped, disagreement costs five", async () => {
  const { scoreQuality } = await import("./stage63-adoption-lib.mjs");
  const result = scoreQuality({
    id: "costs", correct: true, charter_clean: false, quality_ok: false,
    plane_clean: false, dependency_ok: false, owned_loc: 10_000, reviewers_agree: false,
  });
  assert.equal(result.points, 15, "100 - four misses×10 - capped complexity 40 - disagreement 5");
  assert.equal(result.wins, true);
  assert.deepEqual(result.findings.map(({ rule }) => rule), [
    "charter", "quality", "plane", "dependency", "parsimony",
  ]);
});

test("S4 · ranking is deterministic: winners, points, owned LOC, then ID", async () => {
  const { rankQuality } = await import("./stage63-adoption-lib.mjs");
  const conforming = (id, owned_loc) => ({
    id, correct: true, charter_clean: true, quality_ok: true,
    plane_clean: true, dependency_ok: true, owned_loc, reviewers_agree: true,
  });
  assert.deepEqual(rankQuality([
    { ...conforming("incorrect", 1), correct: false },
    conforming("zeta", 100),
    conforming("alpha", 100),
    conforming("larger", 150),
  ]).map(({ id }) => id), ["alpha", "zeta", "larger", "incorrect"]);
});

test("S4 · implementation-quality rows are grounded or honestly gapped", async () => {
  const { ADOPTION, GAP_SLICES } = await import("./stage63-adoption-lib.mjs");
  const rows = Object.keys(ADOPTION).filter((key) => key.startsWith("quality:"));
  assert.equal(rows.length, 4, "S4 contributes exactly four quality rows");
  for (const key of rows) {
    const entry = ADOPTION[key];
    assert.equal(entry.mechanism !== null, entry.gap === null,
      `${key} must have exactly one of mechanism/gap (XOR)`);
    if (entry.mechanism !== null) {
      assert.ok(existsSync(path.join(root, entry.mechanism)),
        `${key} maps to ${entry.mechanism}, which does not exist on disk`);
    } else {
      assert.ok(GAP_SLICES.includes(entry.gap), `${key} has an untracked gap`);
    }
  }
});
