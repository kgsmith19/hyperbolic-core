// m4-19 (07 section 7.11): case format validation, the deterministic
// grader, and both `brain eval run`/`brain eval capture` verbs exercised
// through the REAL dispatch pipeline (ScriptedAdapter + a real throwaway
// git repo, same convention dispatch.test.ts already established) --
// not a mock of runEvalCase's own internals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../src/store.ts";
import { RunJournal } from "../src/journal.ts";
import { submitContract } from "../src/run-service.ts";
import { validateEvalCase, loadCasesFromDir, gradeResult, runEvalCase, captureEvalCase, type EvalCaseFile } from "../src/evals.ts";
import { evalRunVerb, evalCaptureVerb } from "../src/cli/verbs.ts";
import type { AdapterRegistry } from "../src/router.ts";
import type { AdapterInvocation, HarnessAdapter, HarnessId, HarnessSession, ProbeResult } from "../src/adapters/types.ts";
import type { TaskContractV1, ResultContractV1 } from "../src/contracts.ts";

function initSourceRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-src-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  run(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "initial"]);
  return dir;
}

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-db-")), "brain.db");
}

function tmpCasesDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-cases-"));
}

class ScriptedAdapter implements HarnessAdapter {
  readonly id: HarnessId = "claude-code";
  #script: Array<(inv: AdapterInvocation) => Promise<HarnessSession>>;
  attempts: AdapterInvocation[] = [];
  constructor(script: Array<(inv: AdapterInvocation) => Promise<HarnessSession>>) {
    this.#script = script;
  }
  async probe(): Promise<ProbeResult> {
    return { ok: true, version: "1.0.0" };
  }
  async start(inv: AdapterInvocation): Promise<HarnessSession> {
    this.attempts.push(inv);
    const step = this.#script[this.attempts.length - 1];
    if (!step) throw new Error("ScriptedAdapter: no script step left");
    return step(inv);
  }
  async resume(): Promise<HarnessSession> {
    throw new Error("not used");
  }
  async cancel(): Promise<void> {}
}

function fixtureContract(repoUrl: string, taskId: string, runId: string): TaskContractV1 {
  return {
    task_id: taskId,
    run_id: runId,
    title: "eval fixture task",
    repo: { url: repoUrl, ref: "main" },
    harness: { preferred: "claude-code", fallback: [] },
    autonomy: 2,
    prompt: { objective: "do the thing", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: ["**"], denied_paths: [], vault_keys: [], max_turns: 1, wall_clock_min: 1, token_budget: 1, network: "none" },
    acceptance: [{ id: "AC-1", statement: "always true", verify: { command: "true", cwd: "worktree", expect_exit: 0, timeout_s: 5 } }],
    deliverable: { type: "commit", branch: `brain/${taskId}`, push: false, draft_pr: false },
  };
}

function fixtureCase(repoUrl: string, overrides: Partial<EvalCaseFile> = {}): EvalCaseFile {
  return {
    case_id: "case-fixture-1",
    description: "a fixture eval case",
    contract: fixtureContract(repoUrl, "22222222-2222-2222-2222-222222222222", "11111111-1111-1111-1111-111111111111"),
    fixture: { repo_tar: null, git_ref: "main" },
    expected: { status: "succeeded", verdicts: [{ id: "AC-1", pass: true }], max_cost_usd: 1 },
    ...overrides,
  };
}

// --- validateEvalCase -------------------------------------------------------

test("validateEvalCase: a well-formed case validates", () => {
  const repo = initSourceRepo();
  const result = validateEvalCase(fixtureCase(repo));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("validateEvalCase: missing required top-level field is rejected", () => {
  const repo = initSourceRepo();
  const bad = fixtureCase(repo) as unknown as Record<string, unknown>;
  delete bad.expected;
  const result = validateEvalCase(bad);
  assert.equal(result.valid, false);
});

test("validateEvalCase: an embedded contract that itself fails brain.task.v1 is rejected, prefixed 'contract:'", () => {
  const repo = initSourceRepo();
  const bad = fixtureCase(repo);
  bad.contract.deliverable.branch = "main"; // never a default branch
  const result = validateEvalCase(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith("contract:")));
});

// --- loadCasesFromDir --------------------------------------------------------

test("loadCasesFromDir: a missing directory returns [] (no corpus yet -- V1's own state)", () => {
  assert.deepEqual(loadCasesFromDir(path.join(os.tmpdir(), "definitely-does-not-exist-" + Date.now())), []);
});

test("loadCasesFromDir: reads and validates every *.case.json, ignores other files", () => {
  const repo = initSourceRepo();
  const dir = tmpCasesDir();
  fs.writeFileSync(path.join(dir, "a.case.json"), JSON.stringify(fixtureCase(repo, { case_id: "a" })));
  fs.writeFileSync(path.join(dir, "README.md"), "not a case file");
  const loaded = loadCasesFromDir(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.case?.case_id, "a");
  assert.equal(loaded[0]!.errors.length, 0);
});

test("loadCasesFromDir: an unparseable case file is reported, not silently skipped", () => {
  const dir = tmpCasesDir();
  fs.writeFileSync(path.join(dir, "broken.case.json"), "{not json");
  const loaded = loadCasesFromDir(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.case, null);
  assert.ok(loaded[0]!.errors.length > 0);
});

test("loadCasesFromDir: a schema-invalid case file is reported with real errors, not silently skipped", () => {
  const dir = tmpCasesDir();
  fs.writeFileSync(path.join(dir, "invalid.case.json"), JSON.stringify({ case_id: "x" }));
  const loaded = loadCasesFromDir(dir);
  assert.equal(loaded[0]!.case, null);
  assert.ok(loaded[0]!.errors.length > 0);
});

// --- gradeResult --------------------------------------------------------------

const BASE_RESULT: ResultContractV1 = {
  task_id: "t",
  status: "succeeded",
  verdicts: [{ id: "AC-1", pass: true, exit: 0, output_tail: "" }],
  commits: [],
  branch: "brain/t",
  pr_url: null,
  cost: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, usd_estimate: 0.1 },
  duration_s: 1,
  transcript_ref: "x",
  ledger_ref: "x",
};

test("gradeResult: status/verdicts/cost all matching -> pass with no reasons", () => {
  const graded = gradeResult({ status: "succeeded", verdicts: [{ id: "AC-1", pass: true }], max_cost_usd: 1 }, BASE_RESULT);
  assert.equal(graded.pass, true);
  assert.deepEqual(graded.reasons, []);
});

test("gradeResult: a status mismatch fails with a specific reason", () => {
  const graded = gradeResult({ status: "failed" }, BASE_RESULT);
  assert.equal(graded.pass, false);
  assert.match(graded.reasons[0]!, /status/);
});

test("gradeResult: a verdict pass-value mismatch fails", () => {
  const graded = gradeResult({ status: "succeeded", verdicts: [{ id: "AC-1", pass: false }] }, BASE_RESULT);
  assert.equal(graded.pass, false);
  assert.match(graded.reasons.join(";"), /AC-1/);
});

test("gradeResult: a missing verdict id fails", () => {
  const graded = gradeResult({ status: "succeeded", verdicts: [{ id: "AC-missing", pass: true }] }, BASE_RESULT);
  assert.equal(graded.pass, false);
  assert.match(graded.reasons.join(";"), /missing from result/);
});

test("gradeResult: a verdict id not mentioned in expected is never checked (subset check, not exhaustive)", () => {
  const graded = gradeResult({ status: "succeeded" }, BASE_RESULT);
  assert.equal(graded.pass, true);
});

test("gradeResult: cost over the ceiling fails", () => {
  const graded = gradeResult({ status: "succeeded", max_cost_usd: 0.05 }, BASE_RESULT);
  assert.equal(graded.pass, false);
  assert.match(graded.reasons.join(";"), /cost/);
});

test("gradeResult: no max_cost_usd given -> cost is never checked", () => {
  const graded = gradeResult({ status: "succeeded" }, BASE_RESULT);
  assert.equal(graded.pass, true);
});

// --- runEvalCase (real dispatch pipeline) --------------------------------

test("runEvalCase: a case matching its own recorded expectation passes end to end through real dispatch", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const journal = new RunJournal(fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-journal-")));
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-ws-"));
  const claudeCode = new ScriptedAdapter([async () => ({ sessionId: "s", outcome: "accepted", raw: { criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 100 } })]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode };

  const loaded = loadCasesFromDir(tmpCasesDir()); // sanity: empty dir helper unused here
  const caseFile = fixtureCase(repo);
  const outcome = await runEvalCase(store, journal, { adapters, workspacesRoot }, { file: "fixture.case.json", case: caseFile, errors: [] });

  assert.equal(outcome.pass, true, JSON.stringify(outcome.reasons));
  assert.equal(outcome.case_id, "case-fixture-1");
  assert.equal(outcome.actual?.status, "succeeded");
  assert.equal(loaded.length, 0);
});

test("runEvalCase: a regression (status no longer matches expected) fails with a real reason", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-ws-"));
  // Now returns rejected (a real regression) even though the case still expects succeeded.
  const claudeCode = new ScriptedAdapter([async () => ({ sessionId: "s", outcome: "rejected", raw: { criteria: [{ id: "AC-1", method: "command", status: "fail", detail: "exit 1" }] } })]);
  const adapters: AdapterRegistry = { "claude-code": claudeCode };

  const caseFile = fixtureCase(repo);
  const outcome = await runEvalCase(store, undefined, { adapters, workspacesRoot }, { file: "fixture.case.json", case: caseFile, errors: [] });

  assert.equal(outcome.pass, false);
  assert.ok(outcome.reasons.length > 0);
});

test("runEvalCase: a load error (unparseable/invalid case) is a failing outcome, not a thrown exception", async () => {
  const store = new BrainStore(tmpDbPath());
  const outcome = await runEvalCase(store, undefined, { adapters: {}, workspacesRoot: "/nonexistent" }, { file: "broken.case.json", case: null, errors: ["unparseable JSON"] });
  assert.equal(outcome.pass, false);
  assert.deepEqual(outcome.reasons, ["unparseable JSON"]);
});

test("runEvalCase: re-running the same case twice against one store never collides on a primary key (fresh run/task ids each time)", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-ws-"));
  const script = () => Promise.resolve<HarnessSession>({ sessionId: "s", outcome: "accepted", raw: { criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 1 } });
  const adapters: AdapterRegistry = { "claude-code": new ScriptedAdapter([script, script]) };
  const caseFile = fixtureCase(repo);
  const loaded = { file: "fixture.case.json", case: caseFile, errors: [] };

  const first = await runEvalCase(store, undefined, { adapters, workspacesRoot }, loaded);
  const second = await runEvalCase(store, undefined, { adapters, workspacesRoot }, loaded);

  assert.equal(first.pass, true);
  assert.equal(second.pass, true);
  assert.notEqual(first.runId, second.runId);
});

// --- captureEvalCase ----------------------------------------------------------

test("captureEvalCase: freezes a finished run into a case file that validates, and round-trips through the grader", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-ws-"));
  const casesDir = tmpCasesDir();

  const contract = fixtureContract(repo, "22222222-2222-2222-2222-222222222222", "11111111-1111-1111-1111-111111111111");
  const submitted = submitContract(store, contract);
  assert.equal(submitted.ok, true);

  const claudeCode = new ScriptedAdapter([async () => ({ sessionId: "s", outcome: "accepted", raw: { criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 50 } })]);
  const { createDispatchFn } = await import("../src/dispatch.ts");
  const dispatch = createDispatchFn(store, { adapters: { "claude-code": claudeCode }, workspacesRoot });
  await dispatch(store.getTask(contract.task_id)!);

  const captured = captureEvalCase(store, casesDir, contract.run_id, "captured-case", "a captured description");
  assert.equal(captured.ok, true, captured.ok ? "" : JSON.stringify(captured.errors));
  if (!captured.ok) return;

  assert.ok(fs.existsSync(captured.path));
  const onDisk = JSON.parse(fs.readFileSync(captured.path, "utf8")) as EvalCaseFile;
  assert.equal(onDisk.case_id, "captured-case");
  assert.equal(onDisk.expected.status, "succeeded");
  assert.equal(validateEvalCase(onDisk).valid, true);

  // Round-trip: running the freshly captured case against the SAME
  // scripted behavior should pass -- proves capture() records an
  // expectation the real grader actually agrees with, not just "some
  // JSON that happens to validate."
  const rerunAdapter = new ScriptedAdapter([async () => ({ sessionId: "s2", outcome: "accepted", raw: { criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 50 } })]);
  const outcome = await runEvalCase(store, undefined, { adapters: { "claude-code": rerunAdapter }, workspacesRoot }, { file: "captured-case.case.json", case: onDisk, errors: [] });
  assert.equal(outcome.pass, true, JSON.stringify(outcome.reasons));
});

test("captureEvalCase: a run id that doesn't exist fails cleanly", () => {
  const store = new BrainStore(tmpDbPath());
  const result = captureEvalCase(store, tmpCasesDir(), "nonexistent-run", "x", "y");
  assert.equal(result.ok, false);
});

test("captureEvalCase: a run whose task has not finished yet fails cleanly (no result to freeze)", () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const contract = fixtureContract(repo, "22222222-2222-2222-2222-222222222222", "11111111-1111-1111-1111-111111111111");
  submitContract(store, contract);
  const result = captureEvalCase(store, tmpCasesDir(), contract.run_id, "x", "y");
  assert.equal(result.ok, false);
});

// --- CLI verbs -----------------------------------------------------------------

test("evalRunVerb: an empty corpus exits OK with zero cases", async () => {
  const store = new BrainStore(tmpDbPath());
  const result = await evalRunVerb(store, undefined, { adapters: {}, workspacesRoot: "/nonexistent" }, tmpCasesDir());
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, { total: 0, passed: 0, failed: 0, outcomes: [] });
});

test("evalRunVerb: a passing corpus exits 0; a regressing corpus exits 1 -- this issue's own acceptance criterion", async () => {
  const repo = initSourceRepo();
  const casesDir = tmpCasesDir();
  fs.writeFileSync(path.join(casesDir, "pass.case.json"), JSON.stringify(fixtureCase(repo, { case_id: "pass-case" })));

  const passingStore = new BrainStore(tmpDbPath());
  const passingAdapter = new ScriptedAdapter([async () => ({ sessionId: "s", outcome: "accepted", raw: { criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 1 } })]);
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-ws-"));
  const passing = await evalRunVerb(passingStore, undefined, { adapters: { "claude-code": passingAdapter }, workspacesRoot }, casesDir);
  assert.equal(passing.exitCode, 0);

  const regressingStore = new BrainStore(tmpDbPath());
  const regressingAdapter = new ScriptedAdapter([async () => ({ sessionId: "s", outcome: "rejected", raw: { criteria: [{ id: "AC-1", method: "command", status: "fail", detail: "exit 1" }] } })]);
  const regressing = await evalRunVerb(regressingStore, undefined, { adapters: { "claude-code": regressingAdapter }, workspacesRoot }, casesDir);
  assert.equal(regressing.exitCode, 1);
});

test("evalCaptureVerb: captures and reports the on-disk path", async () => {
  const repo = initSourceRepo();
  const store = new BrainStore(tmpDbPath());
  const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brain-eval-ws-"));
  const casesDir = tmpCasesDir();
  const contract = fixtureContract(repo, "22222222-2222-2222-2222-222222222222", "11111111-1111-1111-1111-111111111111");
  submitContract(store, contract);
  const claudeCode = new ScriptedAdapter([async () => ({ sessionId: "s", outcome: "accepted", raw: { criteria: [{ id: "AC-1", method: "command", status: "pass", detail: "exit 0" }], tokens: 1 } })]);
  const { createDispatchFn } = await import("../src/dispatch.ts");
  await createDispatchFn(store, { adapters: { "claude-code": claudeCode }, workspacesRoot })(store.getTask(contract.task_id)!);

  const result = evalCaptureVerb(store, casesDir, { runId: contract.run_id, caseId: "verb-case", description: "d" });
  assert.equal(result.exitCode, 0);
  assert.equal((result.json as { case_id: string }).case_id, "verb-case");
});

test("evalCaptureVerb: a not-found run exits ERROR", () => {
  const store = new BrainStore(tmpDbPath());
  const result = evalCaptureVerb(store, tmpCasesDir(), { runId: "nope" });
  assert.equal(result.exitCode, 1);
});
