// node --test docs/ops/role-contract.test.mjs (run from the repo root)
//
// #467 S2b: the Standard's runtime-neutral role contract, hand-ported.
// tools/role_contract.py (std#300 decide, std#301 record) and the
// tools/role_authority.py rules it reuses, at the commit standard.lock pins,
// are replayed against role-contract-golden.json: the upstream Python's own
// results over the frozen corpus, its collaboration flows, and edge cases that
// probe the Python semantics a JS port gets wrong by default.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CONTRACT, PROVENANCE, decide, record } from "./role-contract-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const golden = JSON.parse(readFileSync(path.join(here, "role-contract-golden.json"), "utf8"));
const lockSha = readFileSync(path.join(root, "standard.lock"), "utf8").match(/^commit: ([0-9a-f]{40})$/m)[1];

test("role contract · golden and port name standard.lock's commit and the generator", () => {
  assert.ok(golden._provenance.startsWith(`agent-engineering-standard @ ${lockSha}: `), golden._provenance);
  assert.match(golden._provenance, /tools\/role_contract\.py \+ tools\/role_authority\.py/);
  assert.equal(golden._generator, "docs/ops/role-contract-golden.py");
  assert.equal(golden._python, "3.12", "regenerate with CI's python3.12");
  assert.ok(PROVENANCE.startsWith(`agent-engineering-standard @ ${lockSha}: `), PROVENANCE);
});

test("role contract · frozen constants equal upstream", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(CONTRACT)), golden.constants);
});

test("role contract · the golden covers every rule, every kind and both sources", () => {
  const seen = new Set([...golden.decide.flatMap((row) => row.result.rules),
    ...golden.record.flatMap((row) => row.receipt.rules)]);
  assert.deepEqual([...seen].sort(), [...golden.constants.RULES].sort());
  assert.deepEqual(new Set(golden.decide.map((row) => row.action?.kind).filter(Boolean)),
    new Set([...golden.constants.KINDS, "delete"]));
  for (const rows of [golden.decide, golden.record]) {
    assert.deepEqual(new Set(rows.map((row) => row.source)), new Set(["corpus", "edge"]));
  }
  assert.equal(golden.decide.filter((row) => row.source === "corpus").length, 35);
  assert.ok(golden.decide.some((row) => row.result.allowed) && golden.decide.some((row) => !row.result.allowed));
});

test("role contract · the upstream corpus's own expectations hold upstream", () => {
  for (const row of golden.decide.filter((r) => r.source === "corpus")) {
    assert.deepEqual(row.result, row.expect, row.id);
  }
  for (const row of golden.record.filter((r) => r.source === "corpus")) {
    assert.deepEqual({ decision: row.receipt.decision, rules: row.receipt.rules }, row.expect, row.id);
  }
});

test("role contract · decide() reproduces upstream on every corpus and edge case", () => {
  for (const row of golden.decide) {
    const [allowed, rules] = decide(row.grant, row.action, row.kwargs);
    assert.deepEqual({ allowed, rules }, row.result, row.id);
  }
});

test("role contract · record() reproduces upstream receipts on every flow step and edge case", () => {
  for (const row of golden.record) {
    assert.deepEqual(record(row.grant, row.action, row.kwargs), row.receipt, row.id);
  }
});

test("role contract · decide() and record() never mutate their inputs", () => {
  for (const row of [...golden.decide, ...golden.record]) {
    const before = JSON.stringify(row);
    decide(row.grant, row.action, row.kwargs);
    record(row.grant, row.action, { task: null, ...row.kwargs });
    assert.equal(JSON.stringify(row), before, row.id);
  }
});
