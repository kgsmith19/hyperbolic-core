// m4-19 harness + m6-01 corpus. The two acceptance criteria that actually
// matter for a gate are proved here end to end against the REAL seed
// corpus: a passing corpus exits 0, and a deliberately regressed case
// makes it exit 1. Everything else in this file guards the grader's own
// comparison rules, which are what decide whether a regression is even
// noticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
import { createEvalFixtureAdapters } from "../src/adapters/fixture.ts";
import { evalRunVerb, evalCaptureVerb } from "../src/cli/eval-verbs.ts";
import { DEFAULT_CASES_DIR, gradeDeterministic, loadEvalCases, materializeFixture, type EvalCaseSpec } from "../src/evals.ts";
import { validateEvalCase } from "../src/contracts.ts";
import type { ResultContractV1, TaskContractV1 } from "../src/contracts.ts";
import type { Run, Task } from "../src/types.ts";

const SEED_CASE_IDS = ["approval-park", "plan-only", "single-task-success", "transport-retry", "verify-failure"];

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function testConfig() {
  const dir = tmpDir("brain-evals-cfg-");
  return loadConfig({ ...process.env, BRAIN_DATA_DIR: dir, BRAIN_DB_PATH: path.join(dir, "brain.db"), BRAIN_WORKSPACES_ROOT: path.join(dir, "workspaces") });
}

/** A copy of the real seed corpus that a test may mutate. Copying rather
 * than hand-writing a synthetic corpus is the point: the regression proof
 * has to run against the cases that actually ship, not a stand-in. */
function copySeedCorpus(): string {
  const dir = tmpDir("brain-evals-corpus-");
  for (const file of fs.readdirSync(DEFAULT_CASES_DIR).filter((f) => f.endsWith(".case.json"))) {
    fs.copyFileSync(path.join(DEFAULT_CASES_DIR, file), path.join(dir, file));
  }
  return dir;
}

// --- corpus shape ---------------------------------------------------------

test("the seed corpus is the 5 cases 07 section 7.11 requires, and every one validates", () => {
  const cases = loadEvalCases();
  assert.deepEqual(
    cases.map((c) => c.spec.case_id).sort(),
    SEED_CASE_IDS
  );
  for (const { spec } of cases) {
    const validation = validateEvalCase(spec);
    assert.equal(validation.valid, true, `${spec.case_id}: ${validation.errors.join(", ")}`);
  }
});

test("the approval-park case documents itself as an approximation", () => {
  // 07 names approval-park as a seed case but the harness cannot exercise
  // a real one (dispatch is called directly, below the scheduler where
  // parking happens). That gap has to stay visible in the case file
  // itself, not just in a README nobody opens.
  const spec = loadEvalCases().find((c) => c.spec.case_id === "approval-park")!.spec;
  assert.match(spec.description, /APPROXIMATION, NOT A LITERAL APPROVAL PARK/);
});

test("a malformed case file fails the corpus loudly instead of being skipped", () => {
  const dir = copySeedCorpus();
  fs.writeFileSync(path.join(dir, "broken.case.json"), JSON.stringify({ case_id: "broken" }));
  assert.throws(() => loadEvalCases(dir), /does not match brain\.eval-case\.v1/);
});

test("repo_files fixtures materialize into a real git repo with no network access", () => {
  const loaded = loadEvalCases().find((c) => c.spec.case_id === "single-task-success")!;
  const fixture = materializeFixture(loaded);
  try {
    assert.equal(fs.existsSync(path.join(fixture.repoUrl, ".git")), true);
    assert.equal(fs.readFileSync(path.join(fixture.repoUrl, "CHANGELOG.md"), "utf8").includes("Changelog"), true);
    assert.equal(fixture.repoRef, "main");
  } finally {
    fixture.cleanup();
  }
});

// --- the deterministic grader --------------------------------------------

function resultWith(overrides: Partial<ResultContractV1> = {}): ResultContractV1 {
  return {
    task_id: "t1",
    status: "succeeded",
    verdicts: [{ id: "AC-1", pass: true, exit: 0, output_tail: "" }],
    commits: [],
    branch: "brain/t1",
    pr_url: null,
    cost: { input_tokens: 10, output_tokens: 0, cache_read_tokens: 0, usd_estimate: null },
    duration_s: 1,
    transcript_ref: "runs/r1.events.ndjson",
    ledger_ref: "kernel-session:s1",
    ...overrides,
  };
}

const PASSING_EXPECTATION: EvalCaseSpec["expected"] = {
  status: "succeeded",
  verdicts: [{ id: "AC-1", pass: true }],
  max_cost_usd: 1,
};

test("the grader passes only when status, verdicts, and cost all match", () => {
  assert.equal(gradeDeterministic(PASSING_EXPECTATION, resultWith()).passed, true);
});

test("a changed terminal status fails the case", () => {
  const grade = gradeDeterministic(PASSING_EXPECTATION, resultWith({ status: "failed" }));
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join("\n"), /status: expected "succeeded", got "failed"/);
});

test("a flipped verdict fails the case", () => {
  const grade = gradeDeterministic(PASSING_EXPECTATION, resultWith({ verdicts: [{ id: "AC-1", pass: false, exit: 1, output_tail: "" }] }));
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join("\n"), /expected pass=true, got pass=false/);
});

test("a verdict that vanished from the result fails the case", () => {
  const grade = gradeDeterministic(PASSING_EXPECTATION, resultWith({ verdicts: [] }));
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join("\n"), /expected but absent/);
});

test("an unexpected extra verdict also fails the case", () => {
  // Ignoring extras would let a case keep passing after the behavior it
  // pins changed underneath it.
  const grade = gradeDeterministic(
    PASSING_EXPECTATION,
    resultWith({ verdicts: [{ id: "AC-1", pass: true, exit: 0, output_tail: "" }, { id: "AC-surprise", pass: true, exit: 0, output_tail: "" }] })
  );
  assert.equal(grade.passed, false);
  assert.match(grade.failures.join("\n"), /present in the result but not expected/);
});

test("exceeding the cost ceiling fails the case; a null estimate counts as zero", () => {
  const overBudget = gradeDeterministic(PASSING_EXPECTATION, resultWith({ cost: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, usd_estimate: 2.5 } }));
  assert.equal(overBudget.passed, false);
  assert.match(overBudget.failures.join("\n"), /exceeds the case ceiling/);

  assert.equal(gradeDeterministic(PASSING_EXPECTATION, resultWith()).passed, true);
});

// --- the gate itself ------------------------------------------------------

test("the seed corpus passes and the command exits 0", async () => {
  const result = await evalRunVerb(testConfig(), { adapters: createEvalFixtureAdapters() });
  const report = result.json as { total: number; passed: number; failed: number };
  assert.equal(report.total, SEED_CASE_IDS.length);
  assert.equal(report.failed, 0, result.humanText);
  assert.equal(result.exitCode, 0);
});

test("a deliberately regressed case makes the gate exit 1", async () => {
  // m4-19's and m6-01's shared acceptance criterion. The regression is
  // introduced the way a real one would appear -- the pipeline now
  // produces a different terminal status than the frozen case recorded --
  // and the whole corpus still runs so the operator sees which case broke.
  const dir = copySeedCorpus();
  const casePath = path.join(dir, "verify-failure.case.json");
  const spec = JSON.parse(fs.readFileSync(casePath, "utf8")) as EvalCaseSpec;
  spec.expected.status = "succeeded";
  fs.writeFileSync(casePath, JSON.stringify(spec, null, 2));

  const result = await evalRunVerb(testConfig(), { adapters: createEvalFixtureAdapters(), casesDir: dir });
  const report = result.json as { failed: number; cases: Array<{ caseId: string; passed: boolean }> };
  assert.equal(result.exitCode, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.cases.find((c) => c.caseId === "verify-failure")!.passed, false);
  // Every other case still ran: one regression must not hide the rest.
  assert.equal(report.cases.length, SEED_CASE_IDS.length);
});

test("an empty corpus exits 0 with a warning rather than failing the gate", async () => {
  // brain-ci.yml wires this step in before any case exists; a gate that
  // failed on "no cases yet" would block its own dependency.
  const result = await evalRunVerb(testConfig(), { adapters: createEvalFixtureAdapters(), casesDir: tmpDir("brain-evals-empty-") });
  assert.equal(result.exitCode, 0);
  assert.match(result.humanText, /corpus is empty/);
});

// --- capture --------------------------------------------------------------

function seedFinishedRun(store: BrainStore): { runId: string; contract: TaskContractV1 } {
  const now = new Date().toISOString();
  const runId = "11111111-1111-4111-8111-111111111111";
  const taskId = "22222222-2222-4222-8222-222222222222";
  const contract: TaskContractV1 = {
    task_id: taskId,
    run_id: runId,
    title: "a real run worth freezing",
    repo: { url: "https://github.com/kgsmith19/hyperbolic-core", ref: "main" },
    harness: { preferred: "claude-code", fallback: [] },
    autonomy: 2,
    prompt: { objective: "do the thing", context_refs: [], prompt_org_refs: [] },
    constraints: { allowed_paths: ["**"], denied_paths: [], vault_keys: [], max_turns: 4, wall_clock_min: 5, token_budget: 1000, network: "none" },
    acceptance: [{ id: "AC-1", statement: "When it finishes, it shall pass.", verify: { command: "true", cwd: "worktree", expect_exit: 0, timeout_s: 30 } }],
    deliverable: { type: "commit", branch: `brain/${taskId}`, push: false, draft_pr: false },
  };
  const result: ResultContractV1 = resultWith({ task_id: taskId, cost: { input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, usd_estimate: 0.2 } });

  const run: Run = { id: runId, objective: "do the thing", autonomy: 2, status: "completed", createdAt: now, updatedAt: now };
  const task: Task = {
    id: taskId,
    runId,
    title: contract.title,
    status: "succeeded",
    contractJson: JSON.stringify(contract),
    resultJson: JSON.stringify(result),
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: now,
  };
  store.insertRun(run);
  store.insertTask(task);
  return { runId, contract };
}

test("capture freezes a finished run into a schema-valid case file", () => {
  const dir = tmpDir("brain-evals-capture-");
  const store = new BrainStore(path.join(dir, "brain.db"));
  try {
    const { runId, contract } = seedFinishedRun(store);
    const casesDir = path.join(dir, "cases");
    const result = evalCaptureVerb(store, { runId, caseId: "captured-example", casesDir });
    assert.equal(result.exitCode, 0);

    const written = JSON.parse(fs.readFileSync(path.join(casesDir, "captured-example.case.json"), "utf8")) as EvalCaseSpec;
    assert.equal(validateEvalCase(written).valid, true);
    assert.deepEqual(written.contract, contract);
    // Expectation derived from what the run actually did, plus headroom.
    assert.equal(written.expected.status, "succeeded");
    assert.deepEqual(written.expected.verdicts, [{ id: "AC-1", pass: true }]);
    assert.ok(written.expected.max_cost_usd > 0.2);
    // 07 calls the captured expectation "operator-edited"; the file has to
    // say so, since capturing a run that failed for a bad reason would
    // otherwise enshrine that failure as correct.
    assert.match(written.description, /REVIEW BEFORE MERGING/);
  } finally {
    store.close();
  }
});

test("capture refuses to overwrite an already-frozen case", () => {
  const dir = tmpDir("brain-evals-capture-dup-");
  const store = new BrainStore(path.join(dir, "brain.db"));
  try {
    const { runId } = seedFinishedRun(store);
    const casesDir = path.join(dir, "cases");
    assert.equal(evalCaptureVerb(store, { runId, caseId: "dup", casesDir }).exitCode, 0);
    const second = evalCaptureVerb(store, { runId, caseId: "dup", casesDir });
    assert.equal(second.exitCode, 1);
    assert.match(second.humanText, /already exists/);
  } finally {
    store.close();
  }
});

test("capture reports not-found for an unknown run", () => {
  const dir = tmpDir("brain-evals-capture-missing-");
  const store = new BrainStore(path.join(dir, "brain.db"));
  try {
    const result = evalCaptureVerb(store, { runId: "no-such-run", caseId: "x", casesDir: path.join(dir, "cases") });
    assert.equal(result.exitCode, 3);
  } finally {
    store.close();
  }
});

test("a corpus run records eval_case and eval_result rows when persisting", async () => {
  const dir = tmpDir("brain-evals-persist-");
  const config = loadConfig({ ...process.env, BRAIN_DATA_DIR: dir, BRAIN_DB_PATH: path.join(dir, "brain.db"), BRAIN_WORKSPACES_ROOT: path.join(dir, "workspaces") });
  const result = await evalRunVerb(config, { adapters: createEvalFixtureAdapters(), persist: true });
  assert.equal(result.exitCode, 0);

  const store = new BrainStore(config.dbPath);
  try {
    for (const caseId of SEED_CASE_IDS) {
      assert.ok(store.getEvalCase(caseId), `${caseId} was not recorded as an eval_case`);
      const results = store.listEvalResultsForCase(caseId);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.passed, true);
      // The synthetic run id is recorded so `brain logs <run_id>` can
      // explain a failure after the fact.
      assert.ok(results[0]!.runId);
    }
  } finally {
    store.close();
  }
});
