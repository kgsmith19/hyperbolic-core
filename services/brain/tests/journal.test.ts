import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunJournal } from "../src/journal.ts";

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-journal-"));
}

test("RunJournal.append: the original wire shape (runId/kind/ts/...extra) survives unchanged -- m4-14's SSE stream and the Shell's brain-run.ts reducer both key off it", () => {
  const journal = new RunJournal(tmpDataDir());
  journal.append({ runId: "run-1", kind: "task.parked_for_approval", taskId: "task-1", reason: "write deliverable at autonomy 1" });
  const [event] = journal.read("run-1");
  assert.equal(event?.runId, "run-1");
  assert.equal(event?.kind, "task.parked_for_approval");
  assert.equal(event?.taskId, "task-1");
  assert.equal(event?.reason, "write deliverable at autonomy 1");
  assert.equal(typeof event?.ts, "string");
});

test("RunJournal.append: every line ALSO satisfies the 07 section 7.9 log schema (ts, level, run_id?, task_id?, invocation_id?, event, fields) -- m4-17", () => {
  const journal = new RunJournal(tmpDataDir());
  journal.append({ runId: "run-1", kind: "task.harness_fallback", taskId: "task-1", invocationId: "inv-1", from: "claude-code", to: "codex", reason: "two consecutive transport failures" });
  const [event] = journal.read("run-1");
  assert.equal(event?.level, "info");
  assert.equal(event?.event, "task.harness_fallback");
  assert.equal(event?.run_id, "run-1");
  assert.equal(event?.task_id, "task-1");
  assert.equal(event?.invocation_id, "inv-1");
  assert.deepEqual(event?.fields, { from: "claude-code", to: "codex", reason: "two consecutive transport failures" });
});

test("RunJournal.append: a level-less, task/invocation-less event (e.g. run.submitted) defaults level to info and omits the optional ids rather than writing null", () => {
  const journal = new RunJournal(tmpDataDir());
  journal.append({ runId: "run-1", kind: "run.submitted", objective: "ship it" });
  const [event] = journal.read("run-1");
  assert.equal(event?.level, "info");
  assert.equal("task_id" in (event as object), false, "omitted, not present as an explicit null/undefined key");
  assert.equal("invocation_id" in (event as object), false);
});

test("RunJournal.append: every persisted line is valid JSON on its own (ndjson, one object per line)", () => {
  const journal = new RunJournal(tmpDataDir());
  journal.append({ runId: "run-1", kind: "a" });
  journal.append({ runId: "run-1", kind: "b" });
  const events = journal.read("run-1");
  assert.equal(events.length, 2);
});
