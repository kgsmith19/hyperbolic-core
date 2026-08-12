// node --test kernel/settings.test.mjs  (run from C:\code\guards)
import { test, after } from "node:test";
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
