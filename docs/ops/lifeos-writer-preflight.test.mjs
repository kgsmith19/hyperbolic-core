import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessLifeosWriters } from "./lifeos-writer-preflight.mjs";

const cases = [
  ["disabled", "enabled", true, "single-monorepo-writer"],
  ["enabled", "disabled", false, "standalone-writer-active"],
  ["enabled", "enabled", false, "dual-writer-risk"],
  ["disabled", "disabled", false, "no-active-monorepo-writer"],
  ["unknown", "enabled", false, "unknown-writer-state"],
  ["disabled", "unknown", false, "unknown-writer-state"],
  [undefined, "enabled", false, "unknown-writer-state"],
  ["enabled", undefined, false, "unknown-writer-state"],
  ["false", "true", false, "unknown-writer-state"],
];
for (const [standalone, monorepo, ready, reason] of cases) {
  test(`writer state ${String(standalone)}/${String(monorepo)} is ${reason}`, () => {
    assert.deepEqual(assessLifeosWriters({ standalone, monorepo }), { ready, reason });
  });
}

test("CLI fails closed for unknown and dual writers without printing input evidence", () => {
  const script = fileURLToPath(new URL("./lifeos-writer-preflight.mjs", import.meta.url));
  for (const args of [[], ["enabled", "enabled"], ["unknown", "enabled"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ["ready", "reason"]);
    assert.equal(result.stderr, "");
  }
});

test("CLI succeeds only for verified standalone-disabled monorepo-enabled", () => {
  const script = fileURLToPath(new URL("./lifeos-writer-preflight.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "disabled", "enabled"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    ready: true,
    reason: "single-monorepo-writer",
  });
});
