import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySession, classifyThrown, mapSessionToResult, tokensFromSession } from "../src/result-mapper.ts";
import { validateResultContract } from "../src/contracts.ts";
import type { HarnessSession } from "../src/adapters/types.ts";

const PARAMS = {
  taskId: "22222222-2222-2222-2222-222222222222",
  branch: "brain/22222222-2222-2222-2222-222222222222",
  durationS: 12.5,
  transcriptRef: "runs/11111111-1111-1111-1111-111111111111.events.ndjson",
  ledgerRef: "kernel-session:s1",
};

test("classifySession: accepted -> none", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "accepted", raw: {} };
  assert.equal(classifySession(session), "none");
});

test("classifySession: rejected (non-zero verdicts) -> logic, never retried", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "rejected", raw: { criteria: [{ id: "AC-1", status: "fail", detail: "" }] } };
  assert.equal(classifySession(session), "logic");
});

test("classifySession: aborted-by-budget -> timeout", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "aborted-by-budget", raw: {} };
  assert.equal(classifySession(session), "timeout");
});

test("classifySession: orphaned -> orphaned", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "orphaned", raw: { error: "kernel produced no stdout to parse" } };
  assert.equal(classifySession(session), "orphaned");
});

test("classifySession: refused -> logic (retrying an identical malformed contract can't help)", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "refused", raw: { errors: ["contract is missing required field \"goal\""] } };
  assert.equal(classifySession(session), "logic");
});

test("classifySession: failed-to-start with a transport signal in the error -> transport", () => {
  for (const msg of ["ECONNRESET", "429 rate limited", "503 Service Unavailable", "the model is overloaded", "failed to spawn kernel: ENOENT"]) {
    const session: HarnessSession = { sessionId: "s", outcome: "failed-to-start", raw: { error: msg } };
    assert.equal(classifySession(session), "transport", `expected transport for: ${msg}`);
  }
});

test("classifySession: failed-to-start with no transport signal -> logic", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "failed-to-start", raw: { error: "settings integrity check failed before launch" } };
  assert.equal(classifySession(session), "logic");
});

test("classifyThrown: always transport (the harness never got a chance to run)", () => {
  assert.equal(classifyThrown(), "transport");
});

test("mapSessionToResult: accepted -> succeeded, verdicts derived from kernel criteria", () => {
  const session: HarnessSession = {
    sessionId: "kernel-run-1",
    outcome: "accepted",
    raw: { criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 1500 },
  };
  const result = mapSessionToResult(session, PARAMS);
  assert.equal(result.status, "succeeded");
  assert.equal(result.verdicts.length, 1);
  assert.equal(result.verdicts[0]!.pass, true);
  assert.equal(result.verdicts[0]!.exit, 0);
  assert.equal(result.cost.input_tokens, 1500);
  // BR-5: cost accounting is queryable with non-null tokens AND dollars,
  // not just tokens with a permanently-null dollar placeholder.
  assert.equal(result.cost.usd_estimate, 0.009);
  assert.equal(tokensFromSession(session), 1500);
  assert.equal(validateResultContract(result).valid, true, JSON.stringify(validateResultContract(result).errors));
});

test("tokensFromSession: no tokens field in raw -> 0, never a crash", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "orphaned", raw: { error: "no stdout" } };
  assert.equal(tokensFromSession(session), 0);
});

test("mapSessionToResult: rejected -> failed, a failing criterion's exit code parsed from its detail text", () => {
  const session: HarnessSession = {
    sessionId: "kernel-run-2",
    outcome: "rejected",
    raw: { criteria: [{ id: "AC-1", method: "command", status: "fail", detail: "exit 3: some stderr tail" }] },
  };
  const result = mapSessionToResult(session, PARAMS);
  assert.equal(result.status, "failed");
  assert.equal(result.verdicts[0]!.pass, false);
  assert.equal(result.verdicts[0]!.exit, 3);
  assert.equal(validateResultContract(result).valid, true);
});

test("mapSessionToResult: aborted-by-budget -> timeout status", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "aborted-by-budget", raw: {} };
  const result = mapSessionToResult(session, PARAMS);
  assert.equal(result.status, "timeout");
  assert.deepEqual(result.verdicts, []);
});

test("mapSessionToResult: orphaned -> interrupted status", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "orphaned", raw: { error: "no stdout" } };
  const result = mapSessionToResult(session, PARAMS);
  assert.equal(result.status, "interrupted");
});

test("mapSessionToResult: no criteria in raw -> empty verdicts, not a crash", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "failed-to-start", raw: { error: "settings integrity check failed" } };
  const result = mapSessionToResult(session, PARAMS);
  assert.deepEqual(result.verdicts, []);
  assert.equal(validateResultContract(result).valid, true);
});

test("mapSessionToResult: always carries the caller's branch/transcript_ref/ledger_ref/task_id through unchanged", () => {
  const session: HarnessSession = { sessionId: "s", outcome: "accepted", raw: {} };
  const result = mapSessionToResult(session, PARAMS);
  assert.equal(result.task_id, PARAMS.taskId);
  assert.equal(result.branch, PARAMS.branch);
  assert.equal(result.transcript_ref, PARAMS.transcriptRef);
  assert.equal(result.ledger_ref, PARAMS.ledgerRef);
  assert.equal(result.duration_s, PARAMS.durationS);
});
