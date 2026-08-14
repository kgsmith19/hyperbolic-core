// m6-01: the eval-only scripted adapters. What matters here is not that
// they return canned values (they obviously do) but that the canned values
// they return still travel through the REAL classification and verdict-
// extraction code the way a genuine harness's would -- a fixture that
// short-circuits result-mapper.ts would make the whole corpus vacuous.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScriptedFixtureAdapter, createEvalFixtureAdapters } from "../src/adapters/fixture.ts";
import { classifySession, extractRawVerdicts } from "../src/result-mapper.ts";
import type { AdapterInvocation } from "../src/adapters/types.ts";

function contractFileWithTitle(title: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-fixture-adapter-"));
  const file = path.join(dir, "task-contract.json");
  fs.writeFileSync(file, JSON.stringify({ title }));
  return file;
}

function invocationFor(contractPath: string): AdapterInvocation {
  return {
    invocationId: "inv-1",
    taskId: "task-1",
    runId: "run-1",
    contractPath,
    worktreePath: "/nonexistent/worktree",
    wallClockMinBudget: 5,
  };
}

test("start() reads the scripted outcome from the contract's title marker", async () => {
  const adapter = new ScriptedFixtureAdapter("claude-code");
  const session = await adapter.start(invocationFor(contractFileWithTitle("Do the thing [[fixture:rejected]]")));
  assert.equal(session.outcome, "rejected");
});

test("a contract with no marker defaults to accepted", async () => {
  const adapter = new ScriptedFixtureAdapter("claude-code");
  const session = await adapter.start(invocationFor(contractFileWithTitle("Do the thing")));
  assert.equal(session.outcome, "accepted");
});

test("an unrecognized marker throws rather than silently defaulting", async () => {
  // A case that meant to script `rejected` and quietly got `accepted`
  // would pass for the wrong reason, which is worse than not running.
  const adapter = new ScriptedFixtureAdapter("claude-code");
  await assert.rejects(
    () => adapter.start(invocationFor(contractFileWithTitle("Do the thing [[fixture:exploded]]"))),
    /unknown outcome marker/
  );
});

test("fixedOutcome overrides the title marker entirely", async () => {
  const adapter = new ScriptedFixtureAdapter("codex", { fixedOutcome: "failed-to-start", tokens: 0 });
  const session = await adapter.start(invocationFor(contractFileWithTitle("Do the thing [[fixture:accepted]]")));
  assert.equal(session.outcome, "failed-to-start");
});

test("a failed-to-start session classifies as transport, not logic", async () => {
  // This is what makes the transport-retry case retry at all: result-
  // mapper.ts only treats failed-to-start as transport when raw.error
  // matches its transport signal regex.
  const adapter = new ScriptedFixtureAdapter("codex", { fixedOutcome: "failed-to-start" });
  const session = await adapter.start(invocationFor(contractFileWithTitle("anything")));
  assert.equal(classifySession(session), "transport");
});

test("sessions carry no criteria, so dispatch falls through to real verification", async () => {
  // extractRawVerdicts() returning empty is precisely the signal
  // dispatch.ts uses to run verify.ts itself instead of trusting the
  // adapter -- if a fixture ever reported its own verdicts, the corpus
  // would be testing its fixtures rather than the Brain.
  const adapter = new ScriptedFixtureAdapter("claude-code");
  const session = await adapter.start(invocationFor(contractFileWithTitle("Do the thing [[fixture:accepted]]")));
  assert.deepEqual(extractRawVerdicts(session), []);
});

test("probe() always succeeds so a case's preferred harness is actually routed to", async () => {
  // router.ts's selectInitialAdapter() silently falls through to
  // claude-code on any probe failure, which would make the transport-retry
  // case never reach codex at all.
  for (const adapter of Object.values(createEvalFixtureAdapters())) {
    const probe = await adapter.probe();
    assert.equal(probe.ok, true);
  }
});

test("the registry keeps HarnessId frozen and scripts one adapter per id", async () => {
  const registry = createEvalFixtureAdapters();
  assert.deepEqual(Object.keys(registry).sort(), ["claude-code", "codex", "gemini"]);

  const contract = invocationFor(contractFileWithTitle("Do the thing [[fixture:accepted]]"));
  // codex always transport-fails and gemini always succeeds regardless of
  // the case's own marker: that fixed asymmetry is what a case selects
  // when it names them as preferred/fallback.
  assert.equal(classifySession(await registry.codex.start(contract)), "transport");
  assert.equal((await registry.gemini.start(contract)).outcome, "accepted");
});

test("token counts reach cost accounting through raw.tokens", async () => {
  const adapter = new ScriptedFixtureAdapter("gemini", { fixedOutcome: "accepted", tokens: 200 });
  const session = await adapter.start(invocationFor(contractFileWithTitle("anything")));
  assert.equal((session.raw as { tokens: number }).tokens, 200);
});
