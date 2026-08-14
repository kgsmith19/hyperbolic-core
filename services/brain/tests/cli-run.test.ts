// Spawns the real bin/brain.mjs (matching packages/toolbelt-cli/tests/
// cli.integration.test.mjs's own "spawn the real executable" convention) --
// proves the process wiring (argv parsing, exit codes, real DB writes)
// end to end, matching m4-09's own Verification section literally:
// "brain run --dry-run "<objective>" prints contracts; exit 0; DB query
// for the printed run id returns the journaled row."
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrainStore } from "../src/store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "brain.mjs");
const FIXTURES = join(__dirname, "fixtures");

function tmpEnv(): { env: NodeJS.ProcessEnv; dbPath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-cli-"));
  const dbPath = path.join(dataDir, "brain.db");
  return { env: { ...process.env, BRAIN_DATA_DIR: dataDir, BRAIN_DB_PATH: dbPath }, dbPath };
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
}

test("brain run --dry-run <objective>: exits 0, prints one contract, journals a run row queryable by its id", () => {
  const { env, dbPath } = tmpEnv();
  const res = runCli(["run", "--dry-run", "add a health endpoint"], env);
  assert.equal(res.status, 0, res.stderr);

  const contracts = JSON.parse(res.stdout);
  assert.equal(contracts.length, 1);
  const [contract] = contracts;
  assert.equal(contract.prompt.objective, "add a health endpoint");

  const store = new BrainStore(dbPath);
  try {
    const run = store.getRun(contract.run_id);
    assert.ok(run, "the printed run id must be journaled");
    assert.equal(run?.id, contract.run_id);
    assert.equal(store.listInvocationsForTask(contract.task_id).length, 0);
  } finally {
    store.close();
  }
});

test("brain run (no --dry-run): refuses with exit 2, writes nothing", () => {
  const { env } = tmpEnv();
  const res = runCli(["run", "add a health endpoint"], env);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--dry-run/);
});

test("brain run --dry-run --contract <valid fixture>: exits 0 and journals the fixture's own run/task ids", () => {
  const { env, dbPath } = tmpEnv();
  const res = runCli(["run", "--dry-run", "--contract", join(FIXTURES, "valid-task-contract.json")], env);
  assert.equal(res.status, 0, res.stderr);

  const store = new BrainStore(dbPath);
  try {
    assert.equal(store.getRun("11111111-1111-1111-1111-111111111111")?.id, "11111111-1111-1111-1111-111111111111");
    assert.equal(store.getTask("22222222-2222-2222-2222-222222222222")?.id, "22222222-2222-2222-2222-222222222222");
  } finally {
    store.close();
  }
});

test("brain run --dry-run --contract <invalid fixture>: exits 2, journals nothing", () => {
  const { env, dbPath } = tmpEnv();
  const res = runCli(["run", "--dry-run", "--contract", join(FIXTURES, "invalid-task-contract.json")], env);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /schema validation/);

  const store = new BrainStore(dbPath);
  try {
    assert.equal(store.getRun("33333333-3333-3333-3333-333333333333"), null, "an invalid contract must leave no run row in a dispatchable state");
  } finally {
    store.close();
  }
});

test("brain run --dry-run with no objective and no --contract: exits 2 with usage", () => {
  const { env } = tmpEnv();
  const res = runCli(["run", "--dry-run"], env);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage: brain/);
});
