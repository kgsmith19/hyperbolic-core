// Kernel-fixture-through-the-adapter test (this issue's own verification
// bullet): a real subprocess spawn against tests/fixtures/kernel/fake-run.mjs
// standing in for the real ACC kernel, proving ClaudeCodeAdapter's
// spawn/env/parse mechanics end to end without needing a real `claude`
// binary or a live ACC checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.ts";
import type { TaskContractV1 } from "../src/contracts.ts";
import type { AdapterInvocation } from "../src/adapters/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_KERNEL = join(__dirname, "fixtures", "kernel", "fake-run.mjs");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixtureContract(goal: string): TaskContractV1 {
  return {
    task_id: "22222222-2222-2222-2222-222222222222",
    run_id: "11111111-1111-1111-1111-111111111111",
    title: "fixture",
    repo: { url: "https://example.invalid/repo", ref: "main" },
    harness: { preferred: "claude-code", fallback: [] },
    autonomy: 2,
    prompt: { objective: goal, context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: ["**"], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "none" },
    acceptance: [],
    deliverable: { type: "commit", branch: "brain/22222222-2222-2222-2222-222222222222", push: false, draft_pr: false },
  };
}

function writeInvocation(goal: string): AdapterInvocation {
  const dir = tmpDir("brain-adapter-inv-");
  const contractPath = path.join(dir, "contract.json");
  fs.writeFileSync(contractPath, JSON.stringify(fixtureContract(goal)));
  return { invocationId: "inv-1", taskId: "task-1", runId: "run-1", contractPath, worktreePath: dir, wallClockMinBudget: 1 };
}

function adapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    kernelRunPath: FAKE_KERNEL,
    accRoot: tmpDir("brain-acc-root-"),
    accPolicy: path.join(tmpDir("brain-acc-policy-"), "policy.json"),
    accVault: path.join(tmpDir("brain-acc-vault-"), "vault.json"),
  });
}

test("start(): a kernel fixture run through the adapter is parsed into an accepted HarnessSession", async () => {
  const inv = writeInvocation("do the thing FAKE_OUTCOME=accepted");
  const session = await adapter().start(inv);
  assert.equal(session.outcome, "accepted");
  assert.ok(session.sessionId, "a ledger-referenceable session id (the kernel's own runId) must be recorded");
  const raw = session.raw as { runId: string; tokens: number };
  assert.match(raw.runId, /^r-fake-/);
});

test("start(): a rejected kernel result (non-zero exit) is still parsed, not treated as a crash", async () => {
  const inv = writeInvocation("do the thing FAKE_OUTCOME=rejected");
  const session = await adapter().start(inv);
  assert.equal(session.outcome, "rejected");
  const raw = session.raw as { criteria: Array<{ status: string }> };
  assert.equal(raw.criteria[0]?.status, "fail");
});

test("start(): failed-to-start with a transport-signal error is parsed with the error preserved for classification", async () => {
  const inv = writeInvocation("do the thing FAKE_OUTCOME=failed-to-start-transport");
  const session = await adapter().start(inv);
  assert.equal(session.outcome, "failed-to-start");
  const raw = session.raw as { error: string };
  assert.match(raw.error, /429/);
});

test("start(): a kernel that exits with no parseable stdout produces an orphaned session, never throws", async () => {
  const inv = writeInvocation("do the thing FAKE_OUTCOME=noop");
  const session = await adapter().start(inv);
  assert.equal(session.outcome, "orphaned");
  const raw = session.raw as { error: string };
  assert.match(raw.error, /no stdout to parse/);
});

test("start(): the mapped kernel contract is written to a real temp file and cleaned up afterward", async () => {
  const inv = writeInvocation("verify staging cleanup FAKE_OUTCOME=accepted");
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("brain-kernel-contract-"));
  await adapter().start(inv);
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("brain-kernel-contract-"));
  assert.equal(after.length, before.length, "staging dir must be removed after the run, not leaked");
});

test("probe(): reports unavailable when the `claude` binary cannot be found (PATH stripped)", async () => {
  const a = adapter();
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = await a.probe();
    assert.equal(result.ok, false);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("resume(): explicitly unsupported -- throws rather than silently starting an unrelated fresh session", async () => {
  const a = adapter();
  await assert.rejects(() => a.resume("some-session", writeInvocation("x")), /resume is not supported/);
});

test("cancel(): a sessionId with no in-flight process is a safe no-op", async () => {
  const a = adapter();
  await a.cancel("never-started", 1000);
});
