// node --test kernel/settings.test.mjs  (run from C:\code\guards)
import { test, after, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-settings-"));
process.env.ACC_ROOT = path.join(BASE, "root");
process.env.ACC_POLICY = path.join(BASE, "policy.json");
fs.writeFileSync(process.env.ACC_POLICY, "{}");

const S = await import("./settings.mjs");
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const contract = {
  goal: "g", constraints: [], rollbackPlan: "none",
  allowedActions: { readRoots: ["C:/x"], writeRoots: ["C:/x/src"], bashPatterns: ["npm test"], networkHosts: [], vaultKeys: [], subagents: [] },
  budget: { wallClockMin: 10, toolCalls: 10, tokens: 100 },
  acceptanceCriteria: [{ id: "AC1", ears: "x", verify: { method: "git_clean" } }],
};

test("the guardhook matcher is exactly the contract's tool allowlist", () => {
  const s = S.generateSettings(contract, { guardhookPath: "C:/g/kernel/guardhook.mjs" });
  const entry = s.hooks.PreToolUse[0];
  assert.deepEqual(entry.matcher.split("|").sort(), ["Bash", "Edit", "Glob", "Grep", "Read", "TodoWrite", "Write"].sort());
  assert.match(entry.hooks[0].command, /guardhook\.mjs/);
});

test("writeRunFiles pins the settings hash and stores the contract for the hook", () => {
  const w = S.writeRunFiles(contract, { runId: "r-pin", guardhookPath: "C:/g/kernel/guardhook.mjs" });
  assert.equal(fs.existsSync(w.settingsPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.contractPath, "utf8")), contract);
  const pin = JSON.parse(fs.readFileSync(w.pinPath, "utf8"));
  assert.equal(pin.settingsSha256, w.sha256);
  assert.equal(w.sha256, S.sha256OfFile(w.settingsPath));
  assert.equal(S.verifySettingsPin(w.dir).ok, true);
});

test("a TAMPERED settings file fails the integrity check (AC-G5, AC-G6)", () => {
  const w = S.writeRunFiles(contract, { runId: "r-tamper", guardhookPath: "C:/g/kernel/guardhook.mjs" });
  const evil = JSON.parse(fs.readFileSync(w.settingsPath, "utf8"));
  evil.hooks.PreToolUse = [];                       // disarm the guard
  fs.writeFileSync(w.settingsPath, JSON.stringify(evil, null, 2));
  const v = S.verifySettingsPin(w.dir);
  assert.equal(v.ok, false);
  assert.notEqual(v.actual, v.expected);
});

test("a missing settings file or pin fails closed, never passes by default", () => {
  const w = S.writeRunFiles(contract, { runId: "r-gone", guardhookPath: "C:/g/kernel/guardhook.mjs" });
  fs.rmSync(w.settingsPath);
  assert.equal(S.verifySettingsPin(w.dir).ok, false);
  assert.equal(S.verifySettingsPin(path.join(BASE, "nope")).ok, false);
});

test("cleanupRun removes the staging directory", () => {
  const w = S.writeRunFiles(contract, { runId: "r-clean", guardhookPath: "C:/g/kernel/guardhook.mjs" });
  S.cleanupRun("r-clean");
  assert.equal(fs.existsSync(w.dir), false);
  assert.doesNotThrow(() => S.cleanupRun("r-never-existed"));
});

// GU-2.1: the generated PreToolUse chain includes the shared Guards hook
// (apps/toolbelt/guards/guard.mjs) alongside the kernel's own guardhook,
// "so the rule surface never differs by launch path" (05-g section 5).
test("generateSettings' PreToolUse chain has the kernel guardhook first, then the shared Guards hook with its own fixed matcher", () => {
  const s = S.generateSettings(contract, { guardhookPath: "C:/g/kernel/guardhook.mjs" });
  assert.equal(s.hooks.PreToolUse.length, 2);
  const [kernelEntry, guardsEntry] = s.hooks.PreToolUse;
  assert.match(kernelEntry.hooks[0].command, /guardhook\.mjs/);
  assert.match(guardsEntry.hooks[0].command, /guard\.mjs/);
  assert.equal(guardsEntry.matcher, "Edit|Write|NotebookEdit|Read");
  assert.equal(guardsEntry.hooks[0].timeout, 15);
});

test("ACC_GUARDS_HOOK overrides the resolved guard.mjs path", () => {
  const original = process.env.ACC_GUARDS_HOOK;
  process.env.ACC_GUARDS_HOOK = "/fake/guard.mjs";
  try {
    const s = S.generateSettings(contract, { guardhookPath: "C:/g/kernel/guardhook.mjs" });
    assert.equal(s.hooks.PreToolUse[1].hooks[0].command, 'node "/fake/guard.mjs"');
  } finally {
    if (original === undefined) delete process.env.ACC_GUARDS_HOOK;
    else process.env.ACC_GUARDS_HOOK = original;
  }
});

// "A disabled guard is never silent" (05-g section 5's failure-semantics
// paragraph): guardsEnabled() surfaces the real `guards status` result
// (never a hardcoded assumption), driven against a FAKE cli.mjs (same
// ACC_GUARDS_CLI override and canned-output discipline gui/server.test.mjs
// already established for the identical script) so this test controls the
// answer instead of depending on the real repo's own config.json state.
describe("guardsEnabled()", () => {
  const fakeCli = path.join(BASE, "fake-guards-cli.mjs");
  let originalCli;

  function setFakeStatus(body) {
    fs.writeFileSync(fakeCli, `process.stdout.write(${JSON.stringify(JSON.stringify(body))});\n`);
  }

  beforeEach(() => {
    originalCli = process.env.ACC_GUARDS_CLI;
    process.env.ACC_GUARDS_CLI = fakeCli;
  });

  afterEach(() => {
    if (originalCli === undefined) delete process.env.ACC_GUARDS_CLI;
    else process.env.ACC_GUARDS_CLI = originalCli;
  });

  test("reflects enabled:true from `guards status`", () => {
    setFakeStatus({ enabled: true, secrets: [], protected: [] });
    assert.equal(S.guardsEnabled(), true);
  });

  test("reflects enabled:false from `guards status` -- this is the exact case that must never be silent", () => {
    setFakeStatus({ enabled: false, secrets: [], protected: [] });
    assert.equal(S.guardsEnabled(), false);
  });

  test("returns null (not false) when the status query itself fails, so unknown is never conflated with disabled", () => {
    fs.writeFileSync(fakeCli, "process.exit(1);\n");
    assert.equal(S.guardsEnabled(), null);
  });

  test("returns null when the CLI's own path does not exist at all", () => {
    process.env.ACC_GUARDS_CLI = "/nonexistent/cli.mjs";
    assert.equal(S.guardsEnabled(), null);
  });
});

test("writeRunFiles surfaces guardsEnabled on its return value and persists it in pin.json", () => {
  const originalCli = process.env.ACC_GUARDS_CLI;
  const fakeCli = path.join(BASE, "fake-guards-cli-writerun.mjs");
  fs.writeFileSync(fakeCli, `process.stdout.write(${JSON.stringify(JSON.stringify({ enabled: true }))});\n`);
  process.env.ACC_GUARDS_CLI = fakeCli;
  try {
    const w = S.writeRunFiles(contract, { runId: "r-guards-enabled", guardhookPath: "C:/g/kernel/guardhook.mjs" });
    assert.equal(w.guardsEnabled, true);
    const pin = JSON.parse(fs.readFileSync(w.pinPath, "utf8"));
    assert.equal(pin.guardsEnabled, true);
  } finally {
    if (originalCli === undefined) delete process.env.ACC_GUARDS_CLI;
    else process.env.ACC_GUARDS_CLI = originalCli;
  }
});
