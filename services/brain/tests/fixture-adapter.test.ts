// m6-01: the eval-only ScriptedFixtureAdapter (src/adapters/fixture.ts) --
// title-marker parsing, the fixedOutcome override the transport-retry
// case's codex/gemini slots rely on, and the "no raw.criteria" shape that
// makes dispatch.ts fall through to real verification (proved end to end,
// against the real dispatch pipeline, by evals.test.ts and the seed cases
// themselves; this file only tests the adapter in isolation).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScriptedFixtureAdapter, createEvalFixtureAdapters } from "../src/adapters/fixture.ts";
import type { AdapterInvocation } from "../src/adapters/types.ts";

function invWithTitle(title: string): AdapterInvocation {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-fixture-adapter-"));
  const contractPath = path.join(dir, "contract.json");
  fs.writeFileSync(contractPath, JSON.stringify({ title }));
  return {
    invocationId: "inv-1",
    taskId: "task-1",
    runId: "run-1",
    contractPath,
    worktreePath: "/nonexistent/worktree",
    wallClockMinBudget: 60,
  };
}

test("ScriptedFixtureAdapter: id is whatever the constructor is given", () => {
  assert.equal(new ScriptedFixtureAdapter("claude-code").id, "claude-code");
  assert.equal(new ScriptedFixtureAdapter("codex").id, "codex");
  assert.equal(new ScriptedFixtureAdapter("gemini").id, "gemini");
});

test("ScriptedFixtureAdapter: probe always reports available -- a case naming it must actually be routed to it", async () => {
  const adapter = new ScriptedFixtureAdapter("claude-code");
  assert.deepEqual(await adapter.probe(), { ok: true, version: "fixture-1.0.0" });
});

test("ScriptedFixtureAdapter: start() reads the [[fixture:<outcome>]] marker out of the contract's own title", async () => {
  const adapter = new ScriptedFixtureAdapter("claude-code");
  const session = await adapter.start(invWithTitle("some case [[fixture:rejected]]"));
  assert.equal(session.outcome, "rejected");
});

test("ScriptedFixtureAdapter: no marker in the title defaults to accepted", async () => {
  const adapter = new ScriptedFixtureAdapter("claude-code");
  const session = await adapter.start(invWithTitle("a title with no marker at all"));
  assert.equal(session.outcome, "accepted");
});

test("ScriptedFixtureAdapter: an unrecognized marker value defaults to accepted rather than throwing", async () => {
  const adapter = new ScriptedFixtureAdapter("claude-code");
  const session = await adapter.start(invWithTitle("case [[fixture:not-a-real-outcome]]"));
  assert.equal(session.outcome, "accepted");
});

test("ScriptedFixtureAdapter: an accepted/rejected/orphaned session carries no raw.criteria -- dispatch.ts must fall through to real verification", async () => {
  const adapter = new ScriptedFixtureAdapter("claude-code");
  const session = await adapter.start(invWithTitle("case [[fixture:accepted]]"));
  assert.equal((session.raw as { criteria?: unknown }).criteria, undefined);
  assert.equal(typeof (session.raw as { tokens?: number }).tokens, "number");
});

test("ScriptedFixtureAdapter: a failed-to-start outcome carries a raw.error matching result-mapper.ts's transport-signal text", async () => {
  const adapter = new ScriptedFixtureAdapter("codex");
  const session = await adapter.start(invWithTitle("case [[fixture:failed-to-start]]"));
  assert.equal(session.outcome, "failed-to-start");
  assert.match((session.raw as { error: string }).error, /failed to spawn/);
});

test("ScriptedFixtureAdapter: fixedOutcome overrides the title marker entirely", async () => {
  const adapter = new ScriptedFixtureAdapter("codex", { fixedOutcome: "failed-to-start" });
  const session = await adapter.start(invWithTitle("case [[fixture:accepted]]"));
  assert.equal(session.outcome, "failed-to-start");
});

test("ScriptedFixtureAdapter: resume() is scripted the same as start(), not a throw", async () => {
  const adapter = new ScriptedFixtureAdapter("claude-code");
  const inv = invWithTitle("case [[fixture:accepted]]");
  const session = await adapter.resume("some-session-id", inv);
  assert.equal(session.outcome, "accepted");
});

test("ScriptedFixtureAdapter: cancel is a no-op", async () => {
  const adapter = new ScriptedFixtureAdapter("claude-code");
  await adapter.cancel("s", 1000);
});

test("createEvalFixtureAdapters: registers exactly the three frozen HarnessIds", () => {
  const adapters = createEvalFixtureAdapters();
  assert.deepEqual(Object.keys(adapters).sort(), ["claude-code", "codex", "gemini"]);
});

test("createEvalFixtureAdapters: codex is fixed to failed-to-start regardless of any title marker", async () => {
  const adapters = createEvalFixtureAdapters();
  const session = await adapters.codex.start(invWithTitle("[[fixture:accepted]]"));
  assert.equal(session.outcome, "failed-to-start");
});

test("createEvalFixtureAdapters: gemini is fixed to accepted regardless of any title marker", async () => {
  const adapters = createEvalFixtureAdapters();
  const session = await adapters.gemini.start(invWithTitle("[[fixture:rejected]]"));
  assert.equal(session.outcome, "accepted");
});

test("createEvalFixtureAdapters: claude-code reads the title marker like a plain ScriptedFixtureAdapter", async () => {
  const adapters = createEvalFixtureAdapters();
  const session = await adapters["claude-code"].start(invWithTitle("[[fixture:rejected]]"));
  assert.equal(session.outcome, "rejected");
});
