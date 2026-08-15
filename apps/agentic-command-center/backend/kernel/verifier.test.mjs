// node --test kernel/verifier.test.mjs  (run from C:\code\guards)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "acc-kernel-verify-"));
process.env.ACC_POLICY = path.join(BASE, "policy.json");
process.env.ACC_ROOT = path.join(BASE, "root");
fs.writeFileSync(process.env.ACC_POLICY, "{}");
fs.writeFileSync(path.join(BASE, "present.txt"), "hello WORLD\n");

const V = await import("./verifier.mjs");
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

const crit = (id, verify) => ({ id, ears: "x", verify });

test("each verify method returns a real pass or fail (AC-V4)", async () => {
  const okExec = () => ({ status: 0, stdout: "", stderr: "" });
  const badExec = () => ({ status: 1, stdout: "", stderr: "boom" });
  assert.equal((await V.verifyCriterion(crit("a", { method: "command", command: "x" }), { cwd: BASE, execFn: okExec })).status, "pass");
  assert.equal((await V.verifyCriterion(crit("b", { method: "command", command: "x" }), { cwd: BASE, execFn: badExec })).status, "fail");
  assert.equal((await V.verifyCriterion(crit("c", { method: "file_exists", path: path.join(BASE, "present.txt") }), { cwd: BASE })).status, "pass");
  assert.equal((await V.verifyCriterion(crit("d", { method: "file_exists", path: path.join(BASE, "absent.txt") }), { cwd: BASE })).status, "fail");
  assert.equal((await V.verifyCriterion(crit("e", { method: "file_contains", path: path.join(BASE, "present.txt"), pattern: "WOR.D" }), { cwd: BASE })).status, "pass");
  assert.equal((await V.verifyCriterion(crit("f", { method: "file_contains", path: path.join(BASE, "present.txt"), pattern: "nope" }), { cwd: BASE })).status, "fail");
  assert.equal((await V.verifyCriterion(crit("g", { method: "file_contains", path: path.join(BASE, "absent.txt"), pattern: "x" }), { cwd: BASE })).status, "fail");
  assert.equal((await V.verifyCriterion(crit("h", { method: "git_clean" }), { cwd: BASE, execFn: () => ({ status: 0, stdout: "" }) })).status, "pass");
  assert.equal((await V.verifyCriterion(crit("i", { method: "git_clean" }), { cwd: BASE, execFn: () => ({ status: 0, stdout: " M a.js\n" }) })).status, "fail");
});

test("an unrecognized method records unknown, never a pass (AC-V4)", async () => {
  const r = await V.verifyCriterion(crit("z", { method: "vibes" }), { cwd: BASE });
  assert.equal(r.status, "unknown");
});

test("OI-019: a malformed verify block records unknown instead of crashing the whole verify/ledger chain (AC-V4 fault tolerance)", async () => {
  // contract.mjs's validateContract only checks that verify.method names a
  // KNOWN method (kernel/contract.mjs REQUIRED_FIELDS/VERIFY_METHODS) — it
  // never checks that the method-specific fields a criterion needs are
  // present or well-formed. Each of these contracts passes validation and
  // reaches the verifier, which used to throw synchronously and crash
  // verifyAll -> runTask's own promise (in the CLI, an uncaught process
  // exit with NO ledger entry ever finalized — the exact "interrupted
  // forever" failure mode this session's other OI-019 fixes also target).
  const noCommand = await V.verifyCriterion(crit("nc", { method: "command" }), { cwd: BASE });
  assert.equal(noCommand.status, "unknown");

  const numericCommand = await V.verifyCriterion(crit("num", { method: "command", command: 42 }), { cwd: BASE });
  assert.equal(numericCommand.status, "unknown");

  const badRegex = await V.verifyCriterion(
    crit("re", { method: "file_contains", path: path.join(BASE, "present.txt"), pattern: "(unbalanced" }),
    { cwd: BASE }
  );
  assert.equal(badRegex.status, "unknown");
  assert.match(badRegex.detail, /verification threw/);
});

test("a criterion with no verify block at all records unknown with a null method", async () => {
  const r = await V.verifyCriterion({ id: "y", ears: "x" }, { cwd: BASE });
  assert.equal(r.status, "unknown");
  assert.equal(r.method, null);
});

test("command verification uses the real spawnSync path when no execFn is injected", async () => {
  const cmd = process.platform === "win32" ? "node --version" : "node --version";
  const r = await V.verifyCriterion(crit("real", { method: "command", command: cmd }), { cwd: BASE });
  assert.equal(r.status, "pass");
});

test("git_clean with a failing git and no stderr still records unknown", async () => {
  const r = await V.verifyCriterion(crit("g2", { method: "git_clean" }), { cwd: BASE, execFn: () => ({ status: 1, stdout: "", stderr: "" }) });
  assert.equal(r.status, "unknown");
});

test("verifyAll tolerates a contract with no acceptanceCriteria field at all", async () => {
  const r = await V.verifyAll({});
  assert.deepEqual(r.criteria, []);
  assert.equal(r.accepted, false);
});

test("every criterion is evaluated individually (AC-V1)", async () => {
  const contract = { acceptanceCriteria: [
    crit("AC1", { method: "file_exists", path: path.join(BASE, "present.txt") }),
    crit("AC2", { method: "file_exists", path: path.join(BASE, "absent.txt") }),
  ] };
  const r = await V.verifyAll(contract, { cwd: BASE });
  assert.deepEqual(r.criteria.map((c) => [c.id, c.status]), [["AC1", "pass"], ["AC2", "fail"]]);
});

test("any fail or unknown makes the run NOT accepted (AC-V2)", async () => {
  const pass = { acceptanceCriteria: [crit("AC1", { method: "file_exists", path: path.join(BASE, "present.txt") })] };
  assert.equal((await V.verifyAll(pass, { cwd: BASE })).accepted, true);
  const withFail = { acceptanceCriteria: [...pass.acceptanceCriteria, crit("AC2", { method: "file_exists", path: path.join(BASE, "absent.txt") })] };
  assert.equal((await V.verifyAll(withFail, { cwd: BASE })).accepted, false);
  const withUnknown = { acceptanceCriteria: [...pass.acceptanceCriteria, crit("AC3", { method: "vibes" })] };
  assert.equal((await V.verifyAll(withUnknown, { cwd: BASE })).accepted, false);
});

test("the verifier ignores anything the harness said about itself (AC-V5)", async () => {
  const contract = {
    harnessClaim: "I verified everything and it all passes",
    acceptanceCriteria: [crit("AC1", { method: "file_exists", path: path.join(BASE, "absent.txt") })],
  };
  const r = await V.verifyAll(contract, { cwd: BASE });
  assert.equal(r.accepted, false, "a harness claim must not be able to flip a real result");
});
