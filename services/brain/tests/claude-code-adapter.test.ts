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

test("start(): run_id/task_id/invocation_id propagate into the kernel's env and back through its own contract-carried ledger ref (07 section 7.9's join key)", async () => {
  const inv = writeInvocation("do the thing FAKE_OUTCOME=echo-ids");
  const session = await adapter().start(inv);
  const raw = session.raw as {
    _brainMetaSeen: { taskId: string; runId: string; invocationId: string };
    envSeen: { runId: string; taskId: string; invocationId: string };
  };
  // _brainMeta is minted from the CONTRACT's own task_id/run_id
  // (kernel-contract.ts reads contract.task_id/contract.run_id, not the
  // AdapterInvocation's) -- fixtureContract()'s fixed UUIDs, not inv's
  // "task-1"/"run-1" fixture ids (the two are always equal in real
  // dispatch.ts usage, since the contract on disk always belongs to the
  // same task the invocation was built from; only this test's fixture
  // wiring keeps them literally distinct).
  assert.deepEqual(raw._brainMetaSeen, {
    contractVersion: "kernel.contract.v1",
    taskId: "22222222-2222-2222-2222-222222222222",
    runId: "11111111-1111-1111-1111-111111111111",
    invocationId: inv.invocationId,
  });
  // The env vars DO come straight from the AdapterInvocation (claude-
  // code.ts's own #spawnKernel), so these match inv's fixture ids exactly.
  assert.deepEqual(raw.envSeen, { runId: inv.runId, taskId: inv.taskId, invocationId: inv.invocationId });
});

test("start(): m4-18 environment audit -- the kernel receives ACC_VAULT as a plain file PATH, never a resolved credential value", async () => {
  const inv = writeInvocation("do the thing FAKE_OUTCOME=echo-ids");
  const session = await adapter().start(inv);
  const raw = session.raw as { accVaultSeen: string | null };
  assert.ok(raw.accVaultSeen, "ACC_VAULT must be set for the kernel to find its own credential-name lookup");
  assert.match(raw.accVaultSeen, /vault\.json$/, "a path, ending in the vault.json filename");
  // Not token/key-shaped: a real secret value would never look like a
  // filesystem path, and a filesystem path never happens to look like a
  // real secret -- this is the same class of check scrubber.ts's own
  // TOKEN_SHAPED_PATTERNS applies to log lines, restated here directly
  // against what the adapter actually handed the kernel subprocess.
  assert.doesNotMatch(raw.accVaultSeen, /^sk-|^gh[pousr]_|^AKIA|^ASIA|^xox[baprs]-|^AIza/);
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
  await assert.doesNotReject(() => a.cancel("never-started", 1000));
});
