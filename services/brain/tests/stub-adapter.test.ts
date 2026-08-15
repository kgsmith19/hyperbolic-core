import { test } from "node:test";
import assert from "node:assert/strict";
import { codexAdapter, geminiAdapter } from "../src/adapters/stub.ts";
import type { AdapterInvocation } from "../src/adapters/types.ts";

const FIXTURE_INV: AdapterInvocation = {
  invocationId: "inv-1",
  taskId: "task-1",
  runId: "run-1",
  contractPath: "/nonexistent/contract.json",
  worktreePath: "/nonexistent/worktree",
  wallClockMinBudget: 60,
};

test("stub adapters: id matches their name", () => {
  assert.equal(codexAdapter.id, "codex");
  assert.equal(geminiAdapter.id, "gemini");
});

test("stub adapters: probe always reports not available", async () => {
  assert.deepEqual(await codexAdapter.probe(), { ok: false, version: "" });
  assert.deepEqual(await geminiAdapter.probe(), { ok: false, version: "" });
});

test("stub adapters: start/resume always throw, never silently no-op", async () => {
  await assert.rejects(() => codexAdapter.start(FIXTURE_INV));
  await assert.rejects(() => codexAdapter.resume("s", FIXTURE_INV));
  await assert.rejects(() => geminiAdapter.start(FIXTURE_INV));
});

test("stub adapters: cancel is a no-op (nothing was ever started)", async () => {
  // The contract is "does not reject": cancelling a session that was never
  // started must be safe, since the scheduler cancels defensively.
  await assert.doesNotReject(() => codexAdapter.cancel("s", 1000));
  await assert.doesNotReject(() => geminiAdapter.cancel("s", 1000));
});
