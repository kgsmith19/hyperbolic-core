import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessLifeosWriters } from "./lifeos-writer-preflight.mjs";

const cases = [
  ["disabled", "enabled", { standalone: "disabled", monorepo: "enabled", ready: true, reason: "single-monorepo-writer" }],
  ["enabled", "disabled", { standalone: "enabled", monorepo: "disabled", ready: false, reason: "standalone-writer-active" }],
  ["enabled", "enabled", { standalone: "enabled", monorepo: "enabled", ready: false, reason: "dual-writer-risk" }],
  ["disabled", "disabled", { standalone: "disabled", monorepo: "disabled", ready: false, reason: "no-active-monorepo-writer" }],
  ["unknown", "enabled", { standalone: null, monorepo: "enabled", ready: false, reason: "unknown-writer-state" }],
  ["disabled", "unknown", { standalone: "disabled", monorepo: null, ready: false, reason: "unknown-writer-state" }],
  [undefined, "enabled", { standalone: null, monorepo: "enabled", ready: false, reason: "unknown-writer-state" }],
  ["enabled", undefined, { standalone: "enabled", monorepo: null, ready: false, reason: "unknown-writer-state" }],
  ["false", "true", { standalone: null, monorepo: null, ready: false, reason: "unknown-writer-state" }],
];
for (const [standalone, monorepo, expected] of cases) {
  test(`writer state ${String(standalone)}/${String(monorepo)} is ${expected.reason}`, () => {
    assert.deepEqual(assessLifeosWriters({ standalone, monorepo }), expected);
  });
}

test("CLI fails closed for unknown and dual writers while reporting normalized observations", () => {
  const script = fileURLToPath(new URL("./lifeos-writer-preflight.mjs", import.meta.url));
  // These process tests are intentionally separate from unit fixtures: they
  // prove the exported evaluator is actually wired to JSON output and exit 1.
  for (const [args, expected] of [
    [[], { standalone: null, monorepo: null, ready: false, reason: "unknown-writer-state" }],
    [["enabled", "enabled"], { standalone: "enabled", monorepo: "enabled", ready: false, reason: "dual-writer-risk" }],
    [["unknown", "enabled"], { standalone: null, monorepo: "enabled", ready: false, reason: "unknown-writer-state" }],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(result.stderr, "");
  }
});

test("CLI succeeds only for verified standalone-disabled monorepo-enabled", () => {
  const script = fileURLToPath(new URL("./lifeos-writer-preflight.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "disabled", "enabled"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    standalone: "disabled",
    monorepo: "enabled",
    ready: true,
    reason: "single-monorepo-writer",
  });
});
