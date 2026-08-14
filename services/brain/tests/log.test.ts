import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainLogger, type LogLine } from "../src/log.ts";

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-log-"));
}

function readLines(file: string): LogLine[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LogLine);
}

test("BrainLogger: every emitted line parses as JSON with the 07 section 7.9 required fields (ts, level, event, fields)", () => {
  const logger = new BrainLogger(tmpDataDir());
  logger.log("info", "run.submitted", { runId: "run-1", taskId: "task-1" }, { objective: "ship it" });
  const [line] = readLines(logger.file);
  assert.ok(line);
  assert.equal(typeof line!.ts, "string");
  assert.equal(line!.level, "info");
  assert.equal(line!.event, "run.submitted");
  assert.equal(line!.run_id, "run-1");
  assert.equal(line!.task_id, "task-1");
  assert.equal(line!.invocation_id, undefined, "not supplied -- optional field stays absent, not null");
  assert.deepEqual(line!.fields, { objective: "ship it" });
});

test("BrainLogger: run_id/task_id/invocation_id are the same trace-model join key across three log lines (07 section 7.9)", () => {
  const logger = new BrainLogger(tmpDataDir());
  logger.log("info", "task.started", { runId: "run-1", taskId: "task-1" });
  logger.log("info", "invocation.cost_recorded", { runId: "run-1", taskId: "task-1", invocationId: "inv-1" });
  logger.log("info", "task.finished", { runId: "run-1", taskId: "task-1" });
  const lines = readLines(logger.file);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.run_id === "run-1"));
  assert.ok(lines.every((l) => l.task_id === "task-1"));
  assert.equal(lines[1]!.invocation_id, "inv-1");
});

test("BrainLogger: appends across instances pointed at the same dataDir (durable, not in-memory only)", () => {
  const dataDir = tmpDataDir();
  new BrainLogger(dataDir).log("warn", "first", {});
  new BrainLogger(dataDir).log("error", "second", {});
  const lines = readLines(new BrainLogger(dataDir).file);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.event), ["first", "second"]);
});
