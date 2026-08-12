// node --test kernel/contract.test.mjs  (run from C:\code\guards)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-contract-"));
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_ROOT = path.join(BASE, "root");
fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: { hardCaps: { wallClockMin: 240 } } }));

const C = await import("./contract.mjs");
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

// A real, portable absolute path outside the repo — NOT a hardcoded
// Windows-style literal ("C:/code/proj"), because path.resolve() only treats
// a drive-letter string as absolute on Windows; on POSIX it is relative to
// cwd, which during a test run IS the repo, silently tripping the protected-
// write-root overlap check for the wrong reason (found via GitHub Actions'
// Linux fast-tier job — the exact hazard this fixture must not repeat).
const PROJ = path.join(BASE, "proj");

const good = () => ({
  goal: "make the suite green",
  constraints: ["no new dependencies"],
  allowedActions: {
    readRoots: [PROJ], writeRoots: [path.join(PROJ, "src")],
    bashPatterns: ["npm test"], networkHosts: [], vaultKeys: [], subagents: [],
  },
  budget: { wallClockMin: 30, toolCalls: 100, tokens: 200000 },
  acceptanceCriteria: [{ id: "AC1", ears: "THE SYSTEM SHALL exit zero.",
    verify: { method: "command", command: "npm test", cwd: PROJ } }],
  rollbackPlan: "git checkout -- src/",
});

test("a complete contract validates", () => {
  assert.deepEqual(C.validateContract(good()), { ok: true, errors: [] });
});

test("a null/undefined contract is treated as empty, reporting every missing field", () => {
  assert.equal(C.validateContract(null).ok, false);
  assert.equal(C.validateContract(undefined).errors.length, C.REQUIRED_FIELDS.length);
});

test("allowedActions with no writeRoots key at all is tolerated (no overlap to check)", () => {
  const c = good();
  delete c.allowedActions.writeRoots;
  assert.equal(C.validateContract(c).ok, true);
});

test("an acceptance criterion missing an id is labeled by position", () => {
  const c = good();
  c.acceptanceCriteria = [{ ears: "x", verify: { method: "command", command: "npm test" } }];
  assert.match(C.validateContract(c).errors.join(" "), /#0 has no id/);
});

test("a contract file with a leading UTF-8 BOM still loads", () => {
  const f = path.join(BASE, "bom.json");
  fs.writeFileSync(f, "﻿" + JSON.stringify(good()));
  assert.deepEqual(C.loadContract(f), good());
});

test("every required field is required, and the error names it (AC-C1)", () => {
  for (const field of C.REQUIRED_FIELDS) {
    const c = good();
    delete c[field];
    const r = C.validateContract(c);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes(field)), `missing ${field} must be reported by name`);
  }
});

test("acceptance criteria must exist and must be verifiable (AC-C2)", () => {
  const empty = good(); empty.acceptanceCriteria = [];
  assert.equal(C.validateContract(empty).ok, false);

  const noVerify = good(); noVerify.acceptanceCriteria = [{ id: "AC1", ears: "x" }];
  assert.match(C.validateContract(noVerify).errors.join(" "), /verify/);

  const badMethod = good();
  badMethod.acceptanceCriteria = [{ id: "AC1", ears: "x", verify: { method: "vibes" } }];
  assert.match(C.validateContract(badMethod).errors.join(" "), /vibes/);

  const dupe = good();
  dupe.acceptanceCriteria = [good().acceptanceCriteria[0], good().acceptanceCriteria[0]];
  assert.match(C.validateContract(dupe).errors.join(" "), /duplicate/i);
});

test("an allowedActions field that is not an array is rejected", () => {
  const c = good();
  c.allowedActions.readRoots = PROJ;
  assert.match(C.validateContract(c).errors.join(" "), /readRoots must be an array/);
});

test("acceptanceCriteria that is present but not an array is rejected", () => {
  const c = good();
  c.acceptanceCriteria = "not an array";
  assert.match(C.validateContract(c).errors.join(" "), /acceptanceCriteria must be an array/);
});

test("writeRoots overlapping a protected path are rejected before launch (AC-C4)", () => {
  for (const root of [path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".claude", "settings.json"), process.cwd()]) {
    const c = good();
    c.allowedActions.writeRoots = [root];
    assert.equal(C.validateContract(c).ok, false, `${root} must be refused`);
    assert.match(C.validateContract(c).errors.join(" "), /protected/i);
  }
});

test("OI-019: a malformed policy.extraDenyWriteRoots entry refuses the contract instead of crashing (AC-C4 fault tolerance)", () => {
  // saveKernelPolicy (kernel/policy.mjs) validates extraDenyWriteRoots as a
  // strList before ever writing it, but nothing stops a hand-edited or
  // corrupted policy.json from carrying a non-string entry — and
  // validateContract calls alwaysDenyWriteRoots() with no try/catch.
  // Reproduced live: a non-string entry (e.g. a stray number) makes
  // path.resolve() throw a TypeError, which propagated straight out of
  // validateContract uncaught. Called from runTask (kernel/run.mjs) with no
  // try/catch around it either, this crashed the WHOLE kernel process before
  // a single ledger entry existed — worse than any other failure this
  // module already handles gracefully, since even a refused contract here
  // gets a clean errors array, not a process exit.
  const before = fs.readFileSync(process.env.ACC_POLICY, "utf8");
  fs.writeFileSync(process.env.ACC_POLICY, JSON.stringify({ kernel: { extraDenyWriteRoots: [123] } }));
  try {
    const r = C.validateContract(good());
    assert.equal(r.ok, false);
    assert.match(r.errors.join(" "), /extraDenyWriteRoots/i);
  } finally {
    fs.writeFileSync(process.env.ACC_POLICY, before);
  }
});

test("OI-019: a non-string writeRoots entry refuses the contract instead of crashing (AC-C4 fault tolerance)", () => {
  // The Array.isArray(actions[key]) check just above only checks that
  // writeRoots IS an array, never that its elements are strings — a
  // contract (possibly LLM-generated, an even less trusted source than a
  // hand-edited policy.json) naming e.g. a stray number hits the exact same
  // norm()-throws-a-TypeError path as the policy-side test above.
  const c = good();
  c.allowedActions.writeRoots = [123];
  const r = C.validateContract(c);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /writeRoots/i);
});

test("a budget above a policy hard cap is rejected (AC-C5)", () => {
  const c = good();
  c.budget.wallClockMin = 241;
  assert.match(C.validateContract(c).errors.join(" "), /hard cap/i);
});

test("the tool allowlist is derived from allowedActions", () => {
  assert.deepEqual(C.toolsFor(good()).sort(), ["Bash", "Edit", "Glob", "Grep", "Read", "TodoWrite", "Write"].sort());
  const readOnly = good();
  readOnly.allowedActions = { readRoots: ["C:/x"], writeRoots: [], bashPatterns: [], networkHosts: [], vaultKeys: [], subagents: [] };
  assert.deepEqual(C.toolsFor(readOnly).sort(), ["Glob", "Grep", "Read", "TodoWrite"].sort());
});

test("toolsFor tolerates a contract with no allowedActions block at all", () => {
  assert.deepEqual(C.toolsFor({}), ["TodoWrite"]);
});

test("the tool allowlist includes WebFetch/WebSearch and Agent when granted", () => {
  const c = good();
  c.allowedActions = {
    readRoots: [], writeRoots: [], bashPatterns: [],
    networkHosts: ["registry.npmjs.org"], vaultKeys: [], subagents: ["Explore"],
  };
  assert.deepEqual(C.toolsFor(c).sort(), ["Agent", "TodoWrite", "WebFetch", "WebSearch"].sort());
});

test("an unreadable contract file fails closed", () => {
  const f = path.join(BASE, "bad.json");
  fs.writeFileSync(f, "{ not json");
  assert.throws(() => C.loadContract(f), /contract unreadable/);
  assert.throws(() => C.loadContract(path.join(BASE, "missing.json")), /contract unreadable/);
});
