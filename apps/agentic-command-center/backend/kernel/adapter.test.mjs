// node --test kernel/adapter.test.mjs  (run from C:\code\guards)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-adapter-"));
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_ROOT = path.join(BASE, "root");

const A = await import("./adapter.mjs");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const setHarness = (harness) =>
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: { harness } }));

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("the configured harness name is the ONLY thing that selects an adapter (AC-A1)", () => {
  setHarness("claude-code");
  assert.equal(A.adapterSpecifier("claude-code"), "./adapters/claude-code.mjs");
  assert.equal(A.adapterSpecifier("codex"), "./adapters/codex.mjs");
});

test("a harness name that could traverse out of adapters/ is refused", () => {
  for (const bad of ["../../evil", "a/b", "Claude Code", "", "x.mjs"]) {
    assert.throws(() => A.adapterSpecifier(bad), /invalid harness name/);
  }
});

test("an unknown harness fails closed — no fallback to another adapter (AC-A3)", async () => {
  setHarness("no-such-harness");
  await assert.rejects(() => A.resolveAdapter(), /is not available/);
});

test("an adapter missing an interface member is refused by name", () => {
  const full = { id: "x", identity() {}, startTask() {}, sendStep() {}, readState() {}, stopTask() {} };
  assert.doesNotThrow(() => A.assertAdapterShape(full, "x"));
  for (const missing of A.ADAPTER_INTERFACE) {
    const partial = { ...full };
    delete partial[missing];
    assert.throws(() => A.assertAdapterShape(partial, "x"), new RegExp(missing));
  }
});

test("resolveAdapter defaults to policy.json kernel.harness (AC-A1)", async () => {
  setHarness("claude-code");
  const mod = await A.resolveAdapter();
  assert.equal(mod.id, "claude-code");
});

// AC-A8: the isolation that makes a harness swap a one-file job. Comments may
// discuss a harness; CODE outside kernel/adapters/ may never name one.
//
// Matches the hyphenated harness id ("claude-code", the string every adapter
// module and policy.json actually use), not the bare word "claude" — the
// bare word also matches the unrelated ".claude" user-settings directory
// name that alwaysDenyWriteRoots() legitimately references.
test("no kernel module outside kernel/adapters/ references a harness (AC-A8)", () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const files = fs.readdirSync(HERE)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
  assert.ok(files.length >= 3, "sanity: the scan must actually find kernel modules");
  for (const f of files) {
    const code = stripComments(fs.readFileSync(path.join(HERE, f), "utf8"));
    assert.doesNotMatch(code, /claude-code|codex|anthropic/i, `${f} names a harness outside kernel/adapters/`);
  }
});
