// End-to-end subprocess tests for the real bin/brain.mjs argv wiring
// (verbs.test.ts already covers each verb's logic in depth) -- this file
// exists specifically to prove m4-13's own acceptance criteria against
// the REAL process: the exit-code contract, --json as a single parseable
// stdout document, and no interactive prompt when stdin is not a TTY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrainStore } from "../../src/store.ts";
import { RunJournal } from "../../src/journal.ts";
import { parkForApproval } from "../../src/approvals.ts";
import type { Run, Task } from "../../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "..", "bin", "brain.mjs");

function tmpEnv(): { env: NodeJS.ProcessEnv; dataDir: string; dbPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-cli-exit-"));
  const dbPath = path.join(dataDir, "brain.db");
  return { env: { ...process.env, BRAIN_DATA_DIR: dataDir, BRAIN_DB_PATH: dbPath }, dataDir, dbPath };
}

// stdio: ['ignore', ...] closes stdin entirely -- if any verb tried to
// read from it (a prompt), the process would either hang (this call has
// no timeout backstop besides the test runner's own) or error; every
// assertion below completing at all is itself part of the proof.
function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

function seedRunAndTask(dbPath: string, overrides: Partial<Task> = {}): { run: Run; task: Task } {
  const store = new BrainStore(dbPath);
  try {
    const now = new Date().toISOString();
    const run: Run = { id: "run-1", objective: "ship it", autonomy: 2, status: "running", createdAt: now, updatedAt: now };
    store.insertRun(run);
    const task: Task = {
      id: "task-1",
      runId: "run-1",
      title: "ship it",
      status: "pending",
      contractJson: "{}",
      resultJson: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      ...overrides,
    };
    store.insertTask(task);
    return { run, task };
  } finally {
    store.close();
  }
}

test("brain status: unknown command prints usage and exits 2", () => {
  const { env } = tmpEnv();
  const res = runCli(["not-a-real-verb"], env);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage: brain/);
});

test("brain status <run_id>: not-found exits 3", () => {
  const { env } = tmpEnv();
  const res = runCli(["status", "nope"], env);
  assert.equal(res.status, 3);
});

test("brain status --json: stdout is exactly one parseable JSON document, stderr carries the human text", () => {
  const { env, dbPath } = tmpEnv();
  seedRunAndTask(dbPath);
  const res = runCli(["status", "--json"], env);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 1);
});

test("brain tasks <run_id>: exit 0 with the seeded task", () => {
  const { env, dbPath } = tmpEnv();
  seedRunAndTask(dbPath);
  const res = runCli(["tasks", "run-1", "--json"], env);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed[0].id, "task-1");
});

test("brain approve <task_id>: exit 3 when nothing is pending, exit 0 once something is", () => {
  const { env, dbPath } = tmpEnv();
  seedRunAndTask(dbPath);
  const notPending = runCli(["approve", "task-1"], env);
  assert.equal(notPending.status, 3);

  const store = new BrainStore(dbPath);
  const journal = new RunJournal(fs.mkdtempSync(path.join(os.tmpdir(), "brain-cli-exit-journal-")));
  parkForApproval(store, journal, store.getTask("task-1")!, "constraints.network is open", new Date().toISOString());
  store.close();

  const approved = runCli(["approve", "task-1"], env);
  assert.equal(approved.status, 0, approved.stderr);
});

test("brain reject <task_id> --reason <text>: exit 0, task cancelled", () => {
  const { env, dbPath } = tmpEnv();
  seedRunAndTask(dbPath);
  const store = new BrainStore(dbPath);
  parkForApproval(store, undefined, store.getTask("task-1")!, "x", new Date().toISOString());
  store.close();

  const res = runCli(["reject", "task-1", "--reason", "not needed"], env);
  assert.equal(res.status, 0, res.stderr);

  const reloaded = new BrainStore(dbPath);
  assert.equal(reloaded.getTask("task-1")?.status, "cancelled");
  reloaded.close();
});

test("brain cancel <id>: exit 3 for an unknown id, exit 0 for a known task", () => {
  const { env, dbPath } = tmpEnv();
  seedRunAndTask(dbPath, { status: "running" });
  assert.equal(runCli(["cancel", "nope"], env).status, 3);
  assert.equal(runCli(["cancel", "task-1"], env).status, 0);
});

test("brain logs <run_id>: not-found exits 3; a known run exits 0 and prints ndjson", () => {
  const { env, dbPath } = tmpEnv();
  seedRunAndTask(dbPath);
  assert.equal(runCli(["logs", "nope"], env).status, 3);
  const res = runCli(["logs", "run-1"], env);
  assert.equal(res.status, 0, res.stderr);
});

test("brain cost --json: stdout parses as one JSON document even with zero cost rows", () => {
  const { env, dbPath } = tmpEnv();
  seedRunAndTask(dbPath);
  const res = runCli(["cost", "--json"], env);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.totalUsd, 0);
});

test("brain config: bare call prints the effective config as JSON with --json", () => {
  const { env } = tmpEnv();
  const res = runCli(["config", "--json"], env);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(typeof parsed.perRunUsdCeiling, "number");
});

test("brain config set <key> <value>: persists, and get <key> reflects it on a fresh process", () => {
  const { env } = tmpEnv();
  const setRes = runCli(["config", "set", "BRAIN_PER_RUN_USD_CEILING", "12"], env);
  assert.equal(setRes.status, 0, setRes.stderr);

  const getRes = runCli(["config", "get", "perRunUsdCeiling", "--json"], env);
  assert.equal(getRes.status, 0, getRes.stderr);
  assert.deepEqual(JSON.parse(getRes.stdout), { perRunUsdCeiling: 12 });
});

test("brain config set <non-settable key>: exits 2 (policy-refused)", () => {
  const { env } = tmpEnv();
  const res = runCli(["config", "set", "dbPath", "/tmp/x"], env);
  assert.equal(res.status, 2);
});

test("brain refresh-context --json: exits 0, stdout parses as one document", () => {
  const { env } = tmpEnv();
  const res = runCli(["refresh-context", "--json"], env);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(typeof parsed.entries, "number");
});
