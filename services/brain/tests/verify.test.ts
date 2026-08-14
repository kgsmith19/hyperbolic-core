// m4-11's own verification bullets: "Seed a task whose verify command is
// false; ... status failed", "verdict-row ... returns all four fields
// non-null", "Timeout fixture case records a failed verdict with the
// timeout noted".
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWorktreeCleanOrCommitted, runVerification } from "../src/verify.ts";
import type { TaskContractV1 } from "../src/contracts.ts";

function tmpWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-verify-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function contractWithAcceptance(acceptance: TaskContractV1["acceptance"]): TaskContractV1 {
  return {
    task_id: "22222222-2222-2222-2222-222222222222",
    run_id: "11111111-1111-1111-1111-111111111111",
    title: "x",
    repo: { url: "https://example.invalid/repo", ref: "main" },
    harness: { preferred: "claude-code", fallback: [] },
    autonomy: 2,
    prompt: { objective: "x", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: ["**"], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "none" },
    acceptance,
    deliverable: { type: "commit", branch: "brain/22222222-2222-2222-2222-222222222222", push: false, draft_pr: false },
  };
}

test("runVerification: empty acceptance array falls back to the worktree-exists placeholder, passing", async () => {
  const worktree = tmpWorktree();
  const verdicts = await runVerification(contractWithAcceptance([]), worktree);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.pass, true);
});

test("runVerification: a passing command (`true`) records pass=true, exit=0", async () => {
  const worktree = tmpWorktree();
  const contract = contractWithAcceptance([{ id: "AC-1", statement: "trivially true", verify: { command: "true", cwd: "worktree", expect_exit: 0, timeout_s: 5 } }]);
  const [verdict] = await runVerification(contract, worktree);
  assert.equal(verdict!.pass, true);
  assert.equal(verdict!.exit, 0);
});

test("runVerification: the literal command `false` is recorded failed (BR-2's own acceptance-criteria example)", async () => {
  const worktree = tmpWorktree();
  const contract = contractWithAcceptance([{ id: "AC-1", statement: "never passes", verify: { command: "false", cwd: "worktree", expect_exit: 0, timeout_s: 5 } }]);
  const [verdict] = await runVerification(contract, worktree);
  assert.equal(verdict!.id, "AC-1");
  assert.equal(verdict!.pass, false);
  assert.equal(verdict!.exit, 1);
  assert.ok(verdict!.output_tail !== null && verdict!.output_tail !== undefined);
});

test("runVerification: every verdict has all four required fields non-null", async () => {
  const worktree = tmpWorktree();
  const contract = contractWithAcceptance([{ id: "AC-1", statement: "x", verify: { command: "echo hi", cwd: "worktree", expect_exit: 0, timeout_s: 5 } }]);
  const [verdict] = await runVerification(contract, worktree);
  assert.ok(verdict!.id !== null && verdict!.id !== undefined);
  assert.equal(typeof verdict!.pass, "boolean");
  assert.equal(typeof verdict!.exit, "number");
  assert.ok(verdict!.output_tail !== null && verdict!.output_tail !== undefined);
});

test("runVerification: a non-zero expect_exit is honored directly (unlike the kernel's own exit-0-only command check)", async () => {
  const worktree = tmpWorktree();
  const contract = contractWithAcceptance([{ id: "AC-1", statement: "exits 3", verify: { command: "exit 3", cwd: "worktree", expect_exit: 3, timeout_s: 5 } }]);
  const [verdict] = await runVerification(contract, worktree);
  assert.equal(verdict!.pass, true);
  assert.equal(verdict!.exit, 3);
});

test("runVerification: a command exceeding timeout_s is killed and recorded as a failed verdict noting the timeout", async () => {
  const worktree = tmpWorktree();
  const contract = contractWithAcceptance([{ id: "AC-1", statement: "hangs", verify: { command: "sleep 30", cwd: "worktree", expect_exit: 0, timeout_s: 1 } }]);
  const start = Date.now();
  const [verdict] = await runVerification(contract, worktree);
  const elapsedMs = Date.now() - start;
  assert.equal(verdict!.pass, false);
  assert.match(verdict!.output_tail, /TIMEOUT/);
  assert.ok(elapsedMs < 10_000, `expected the kill to happen near the 1s timeout, took ${elapsedMs}ms`);
});

test("runVerification: multiple criteria all run, in order, independently pass/fail", async () => {
  const worktree = tmpWorktree();
  const contract = contractWithAcceptance([
    { id: "AC-1", statement: "passes", verify: { command: "true", cwd: "worktree", expect_exit: 0, timeout_s: 5 } },
    { id: "AC-2", statement: "fails", verify: { command: "false", cwd: "worktree", expect_exit: 0, timeout_s: 5 } },
  ]);
  const verdicts = await runVerification(contract, worktree);
  assert.equal(verdicts.length, 2);
  assert.deepEqual(verdicts.map((v) => v.id), ["AC-1", "AC-2"]);
  assert.equal(verdicts[0]!.pass, true);
  assert.equal(verdicts[1]!.pass, false);
});

test("isWorktreeCleanOrCommitted: a freshly-cloned, untouched worktree is clean", async () => {
  const worktree = tmpWorktree();
  assert.equal(await isWorktreeCleanOrCommitted(worktree), true);
});

test("isWorktreeCleanOrCommitted: an uncommitted change makes it dirty", async () => {
  const worktree = tmpWorktree();
  fs.writeFileSync(path.join(worktree, "README.md"), "modified\n");
  assert.equal(await isWorktreeCleanOrCommitted(worktree), false);
});

test("isWorktreeCleanOrCommitted: committing the change makes it clean again", async () => {
  const worktree = tmpWorktree();
  fs.writeFileSync(path.join(worktree, "README.md"), "modified\n");
  execFileSync("git", ["add", "."], { cwd: worktree });
  execFileSync("git", ["commit", "-q", "-m", "update"], { cwd: worktree });
  assert.equal(await isWorktreeCleanOrCommitted(worktree), true);
});

test("isWorktreeCleanOrCommitted: an untracked (new) file also makes it dirty", async () => {
  const worktree = tmpWorktree();
  fs.writeFileSync(path.join(worktree, "new-file.txt"), "x");
  assert.equal(await isWorktreeCleanOrCommitted(worktree), false);
});
