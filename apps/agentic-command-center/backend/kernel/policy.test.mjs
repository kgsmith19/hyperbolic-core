// node --test kernel/policy.test.mjs  (run from C:\code\guards)
// Hermetic: ACC_POLICY/ACC_ROOT point at throwaway paths BEFORE the import.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Independent oracle for the two "unset env var falls back to the real repo"
// tests below: computed the same way policy.mjs computes it (one level up
// from this file's own directory), not imported from the module under test.
const REAL_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-policy-"));
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_ROOT = path.join(BASE, "root");

const { loadKernelPolicy, KERNEL_DEFAULTS, kernelRoot, alwaysDenyWriteRoots, saveKernelPolicy } =
  await import("./policy.mjs");

const writePolicy = (kernel) =>
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify(kernel ? { kernel } : {}));

after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test("absent policy file yields the defaults", () => {
  fs.rmSync(process.env.ACC_POLICY, { force: true });
  assert.equal(loadKernelPolicy().budget.wallClockMin, KERNEL_DEFAULTS.budget.wallClockMin);
});

test("a policy edit applies to the NEXT call with no restart (AC-G9, AC-U2)", () => {
  writePolicy({ budget: { toolCalls: 7 } });
  assert.equal(loadKernelPolicy().budget.toolCalls, 7);
  writePolicy({ budget: { toolCalls: 9 } });
  assert.equal(loadKernelPolicy().budget.toolCalls, 9, "must re-read, never cache");
});

test("a partial block keeps the other defaults", () => {
  writePolicy({ budget: { toolCalls: 5 } });
  const p = loadKernelPolicy();
  assert.equal(p.budget.toolCalls, 5);
  assert.equal(p.budget.wallClockMin, KERNEL_DEFAULTS.budget.wallClockMin);
  assert.equal(p.autonomy.window, KERNEL_DEFAULTS.autonomy.window);
});

test("a corrupt policy file THROWS so callers fail closed, never guesses dials", () => {
  fs.writeFileSync(process.env.ACC_POLICY, "{ not json");
  assert.throws(() => loadKernelPolicy(), /kernel policy unreadable/);
});

test("always-deny write roots cover the guards repo and the user .claude dir (AC-G7)", () => {
  writePolicy({});
  const roots = alwaysDenyWriteRoots();
  const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
  assert.ok(roots.includes(norm(path.join(os.homedir(), ".claude"))));
  assert.ok(roots.every((r) => r === r.toLowerCase() && !r.includes("\\")), "roots must be normalized");
});

// ALN-1 (05-g-guards.md section 3b, m5-09): the kernel's deny-write roots
// union in Guards' own protected list, read as data -- never imported --
// and the failure mode is no wider, never no guard.
test("ALN-1: a guardsConfigPath union includes every Guards protected path, base and profile overlay both", () => {
  const guardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-guards-"));
  const profile = "policy-test-machine";
  fs.writeFileSync(path.join(guardsDir, "config.json"), JSON.stringify({ enabled: true, secrets: [".env"] }));
  fs.writeFileSync(
    path.join(guardsDir, `config.${profile}.json`),
    JSON.stringify({ protected: [path.join(guardsDir, "settings.json"), path.join(guardsDir, "vault.json")] }),
  );
  const savedProfile = process.env.GUARDS_PROFILE;
  process.env.GUARDS_PROFILE = profile;
  try {
    writePolicy({ guardsConfigPath: path.join(guardsDir, "config.json") });
    const roots = alwaysDenyWriteRoots();
    const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
    assert.ok(roots.includes(norm(path.join(guardsDir, "settings.json"))));
    assert.ok(roots.includes(norm(path.join(guardsDir, "vault.json"))));
    // The base + repo/.claude roots are still present -- a union, not a
    // replacement.
    assert.ok(roots.includes(norm(path.join(os.homedir(), ".claude"))));
  } finally {
    if (savedProfile === undefined) delete process.env.GUARDS_PROFILE;
    else process.env.GUARDS_PROFILE = savedProfile;
  }
});

test("ALN-1: an unreadable guardsConfigPath leaves the built-in roots unchanged and never throws", () => {
  writePolicy({ guardsConfigPath: path.join(BASE, "definitely-does-not-exist", "config.json") });
  const roots = alwaysDenyWriteRoots();
  const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
  // The built-in roots survive exactly as they would with no
  // guardsConfigPath set at all -- "no wider", never "no guard".
  assert.ok(roots.includes(norm(REAL_REPO_ROOT)));
  assert.ok(roots.includes(norm(path.join(os.homedir(), ".claude"))));
});

test("ALN-1: a malformed (unparseable) guardsConfigPath also fails no-wider, not no-guard", () => {
  const guardsDir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-guards-"));
  fs.writeFileSync(path.join(guardsDir, "config.json"), "{ not json");
  writePolicy({ guardsConfigPath: path.join(guardsDir, "config.json") });
  const roots = alwaysDenyWriteRoots();
  const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
  assert.ok(roots.includes(norm(path.join(os.homedir(), ".claude"))));
});

test("kernelRoot honors ACC_ROOT so tests never touch live state", () => {
  assert.equal(kernelRoot(), path.resolve(process.env.ACC_ROOT));
});

test("kernelRoot falls back to the repo root when ACC_ROOT is unset", () => {
  const saved = process.env.ACC_ROOT;
  delete process.env.ACC_ROOT;
  try {
    // Must resolve to the ACTUAL repo root, not merely "some absolute path"
    // (a hardcoded unrelated absolute path would have passed the old assertion).
    assert.equal(kernelRoot(), REAL_REPO_ROOT);
  } finally {
    process.env.ACC_ROOT = saved;
  }
});

test("loadKernelPolicy falls back to the repo policy.json when ACC_POLICY is unset (read-only)", () => {
  const saved = process.env.ACC_POLICY;
  delete process.env.ACC_POLICY;
  try {
    // Must actually read the real repo's policy.json, not merely "not throw"
    // (a function hardcoded to return {} would have passed the old assertion).
    const real = JSON.parse(fs.readFileSync(path.join(REAL_REPO_ROOT, "policy.json"), "utf8"));
    const wantHarness = (real.kernel || {}).harness ?? KERNEL_DEFAULTS.harness;
    assert.equal(loadKernelPolicy().harness, wantHarness);
  } finally {
    process.env.ACC_POLICY = saved;
  }
});

test("a policy file with a leading UTF-8 BOM still parses", () => {
  fs.writeFileSync(process.env.ACC_POLICY, "﻿" + JSON.stringify({ kernel: { budget: { toolCalls: 3 } } }));
  assert.equal(loadKernelPolicy().budget.toolCalls, 3);
});

const goodBlock = () => {
  const k = loadKernelPolicy();
  return {
    harness: "claude-code",
    budget: { wallClockMin: k.budget.wallClockMin, toolCalls: 150, tokens: k.budget.tokens },
    hardCaps: { wallClockMin: k.hardCaps.wallClockMin },
    autonomy: { ...k.autonomy },
    checkpointMin: k.checkpointMin,
    alwaysAllowTools: ["TodoWrite"],
    extraDenyWriteRoots: [],
  };
};

test("saveKernelPolicy round-trips through the file and preserves everything it does not own", () => {
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({
    context: { softK: 400 },
    kernel: { ...goodBlock(), _note: "keep me" },
  }, null, 2));
  const saved = saveKernelPolicy({
    ...goodBlock(), budget: { ...goodBlock().budget, toolCalls: 99 },
    extraDenyWriteRoots: ["  C:/some/root  "],
  });
  assert.equal(saved.budget.toolCalls, 99);
  assert.deepEqual(saved.extraDenyWriteRoots, ["C:/some/root"], "list entries are trimmed");
  const onDisk = JSON.parse(fs.readFileSync(process.env.ACC_POLICY, "utf8"));
  assert.equal(onDisk.kernel.budget.toolCalls, 99);
  assert.equal(onDisk.kernel._note, "keep me", "unknown kernel keys survive");
  assert.equal(onDisk.context.softK, 400, "other policy blocks survive");
});

test("an invalid block is rejected atom-for-atom: throws, file byte-identical", () => {
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: goodBlock() }, null, 2));
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  for (const evil of [
    { ...goodBlock(), harness: "" },
    { ...goodBlock(), budget: { ...goodBlock().budget, toolCalls: 0 } },
    { ...goodBlock(), budget: { ...goodBlock().budget, tokens: 1.5 } },
    { ...goodBlock(), autonomy: { ...goodBlock().autonomy, rejectRate: 5 } },
    { ...goodBlock(), autonomy: { ...goodBlock().autonomy, factor: 0 } },
    { ...goodBlock(), checkpointMin: -1 },
    { ...goodBlock(), alwaysAllowTools: ["", "x"] },
    { ...goodBlock(), alwaysAllowTools: "TodoWrite" },
  ]) {
    assert.throws(() => saveKernelPolicy(evil), /kernel policy:/);
    assert.equal(fs.readFileSync(process.env.ACC_POLICY, "utf8"), before, "rejected save must not touch the file");
  }
});

test("saveKernelPolicy with no policy file fails closed instead of inventing one", () => {
  fs.rmSync(process.env.ACC_POLICY, { force: true });
  assert.throws(() => saveKernelPolicy(goodBlock()), /cannot edit/);
});
