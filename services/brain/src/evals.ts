/**
 * The Brain's eval harness (m4-19, 07-brain-architecture.md section 7.11):
 * a corpus of frozen cases at services/brain/evals/cases/*.case.json, each
 * re-dispatched through the REAL dispatch pipeline and graded
 * deterministically against its recorded expectation.
 *
 * What is real here and what is not: everything from createDispatchFn()
 * downward runs unmodified -- the git worktree is a real worktree, the
 * acceptance commands are really spawned by verify.ts, the worktree-clean
 * check really runs `git status`, and the terminal status comes out of
 * result-mapper.ts's own mapping. The only thing a caller substitutes is
 * the adapter registry, because a genuine harness needs a live provider
 * credential that the PR gate deliberately does not have
 * (10-cicd-deployment.md section 6). See adapters/fixture.ts.
 *
 * The LLM rubric grader (07 section 7.11's secondary grader, report-type
 * deliverables only) is deferred behind RubricGrader below, per that
 * section's own cut line -- the interface is stable, the implementation is
 * not V1's.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrainStore } from "./store.ts";
import { RunJournal } from "./journal.ts";
import { createDispatchFn } from "./dispatch.ts";
import type { AdapterRegistry } from "./router.ts";
import { validateEvalCase, validateTaskContract, type ResultContractV1, type TaskContractV1 } from "./contracts.ts";
import type { Run, Task } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** services/brain/evals/cases. Note this directory is NOT copied into the
 * production Docker image (its Dockerfile COPYs services/brain/src only):
 * the corpus is a development and CI artifact, not something the daemon
 * ever reads at runtime. */
export const DEFAULT_CASES_DIR = path.resolve(HERE, "..", "evals", "cases");

const CASE_FILE_SUFFIX = ".case.json";

// --- case format ---------------------------------------------------------

export interface ExpectedVerdict {
  id: string;
  pass: boolean;
  exit?: number;
}

export interface EvalCaseSpec {
  case_id: string;
  description: string;
  contract: TaskContractV1;
  fixture:
    | { kind: "repo_files"; files: Record<string, string> }
    | { kind: "repo_tar"; path: string }
    | { kind: "git_ref"; url?: string; ref?: string };
  expected: {
    status: ResultContractV1["status"];
    verdicts: ExpectedVerdict[];
    max_cost_usd: number;
  };
}

export interface LoadedEvalCase {
  spec: EvalCaseSpec;
  filePath: string;
}

/** Every *.case.json in the directory, sorted by filename so a corpus run
 * is ordered identically on every machine. A file that fails schema
 * validation throws rather than being skipped -- a case the harness cannot
 * read is a broken gate, not an absent case. */
export function loadEvalCases(casesDir: string = DEFAULT_CASES_DIR): LoadedEvalCase[] {
  if (!existsSync(casesDir)) return [];
  const files = readdirSync(casesDir)
    .filter((f) => f.endsWith(CASE_FILE_SUFFIX))
    .sort();

  const loaded: LoadedEvalCase[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const filePath = path.join(casesDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new Error(`eval case ${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    const validation = validateEvalCase(parsed);
    if (!validation.valid) {
      throw new Error(`eval case ${file}: does not match brain.eval-case.v1:\n  ${validation.errors.join("\n  ")}`);
    }
    const spec = parsed as EvalCaseSpec;
    if (seen.has(spec.case_id)) {
      throw new Error(`eval case ${file}: duplicate case_id "${spec.case_id}" (case ids are the eval_case primary key and must be unique across the corpus)`);
    }
    seen.add(spec.case_id);
    loaded.push({ spec, filePath });
  }
  return loaded;
}

// --- fixtures ------------------------------------------------------------

interface MaterializedFixture {
  repoUrl: string;
  repoRef: string;
  cleanup: () => void;
}

function gitEnv(): NodeJS.ProcessEnv {
  // An eval run must not depend on the machine's git identity being
  // configured (CI runners routinely have none), and must not pick up a
  // developer's own commit signing config either.
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "brain-eval",
    GIT_AUTHOR_EMAIL: "brain-eval@hyperbolic-core.invalid",
    GIT_COMMITTER_NAME: "brain-eval",
    GIT_COMMITTER_EMAIL: "brain-eval@hyperbolic-core.invalid",
  };
}

function initRepoAt(dir: string): void {
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env: gitEnv(), stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["-c", "commit.gpgsign=false", "add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "eval fixture"]);
}

/** Turns a case's `fixture` into a concrete (repoUrl, repoRef) pair the
 * real worktree code can clone from. repo_files and repo_tar both produce
 * a throwaway local git repo, so a corpus run needs no network access at
 * all; git_ref passes the contract's own repo through untouched (used by
 * captured cases that pin a real upstream ref). */
export function materializeFixture(loaded: LoadedEvalCase): MaterializedFixture {
  const { spec, filePath } = loaded;
  const fixture = spec.fixture;

  if (fixture.kind === "git_ref") {
    return {
      repoUrl: fixture.url ?? spec.contract.repo.url,
      repoRef: fixture.ref ?? spec.contract.repo.ref,
      cleanup: () => {},
    };
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), `brain-eval-fixture-${spec.case_id}-`));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  try {
    if (fixture.kind === "repo_files") {
      for (const [relPath, contents] of Object.entries(fixture.files)) {
        // The schema's own propertyNames pattern already rejects absolute
        // paths and a leading "-"; this rejects traversal, so a case file
        // can never write outside its own fixture directory.
        const target = path.resolve(dir, relPath);
        if (!target.startsWith(dir + path.sep)) {
          throw new Error(`eval case ${spec.case_id}: fixture file path "${relPath}" escapes the fixture directory`);
        }
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, contents);
      }
      initRepoAt(dir);
    } else {
      const tarPath = path.resolve(path.dirname(filePath), fixture.path);
      execFileSync("tar", ["-xf", tarPath, "-C", dir], { stdio: "pipe" });
      if (!existsSync(path.join(dir, ".git"))) initRepoAt(dir);
    }
  } catch (err) {
    cleanup();
    throw err;
  }

  return { repoUrl: dir, repoRef: "main", cleanup };
}

// --- deterministic grader ------------------------------------------------

export interface GradeReport {
  passed: boolean;
  failures: string[];
}

/** 07 section 7.11's primary grader: "run the case, compare status +
 * verdicts + cost ceiling". Verdict ids must match EXACTLY in both
 * directions -- an actual result carrying a criterion the case never
 * expected is as much a regression as a missing one, and silently
 * ignoring extras would let a case keep passing after the behavior it
 * pins has changed underneath it. */
export function gradeDeterministic(expected: EvalCaseSpec["expected"], result: ResultContractV1): GradeReport {
  const failures: string[] = [];

  if (result.status !== expected.status) {
    failures.push(`status: expected "${expected.status}", got "${result.status}"`);
  }

  const actualById = new Map(result.verdicts.map((v) => [v.id, v]));
  for (const want of expected.verdicts) {
    const got = actualById.get(want.id);
    if (!got) {
      failures.push(`verdict "${want.id}": expected but absent from the result`);
      continue;
    }
    if (got.pass !== want.pass) {
      failures.push(`verdict "${want.id}": expected pass=${want.pass}, got pass=${got.pass} (exit ${got.exit})`);
    }
    if (want.exit !== undefined && got.exit !== want.exit) {
      failures.push(`verdict "${want.id}": expected exit=${want.exit}, got exit=${got.exit}`);
    }
  }
  const expectedIds = new Set(expected.verdicts.map((v) => v.id));
  for (const got of result.verdicts) {
    if (!expectedIds.has(got.id)) failures.push(`verdict "${got.id}": present in the result but not expected by the case`);
  }

  // A null usd_estimate means no pricing was resolved for whatever
  // harness ran (result-mapper.ts leaves it null until m4-17's telemetry
  // is wired for that harness); counting it as 0 keeps the ceiling
  // meaningful for the harnesses that do report, without failing every
  // case for the ones that do not.
  const actualCost = result.cost.usd_estimate ?? 0;
  if (actualCost > expected.max_cost_usd) {
    failures.push(`cost: $${actualCost.toFixed(4)} exceeds the case ceiling of $${expected.max_cost_usd.toFixed(4)}`);
  }

  return { passed: failures.length === 0, failures };
}

// --- rubric grader (deferred behind its interface, 07 section 7.11) ------

export interface RubricGradeInput {
  spec: EvalCaseSpec;
  result: ResultContractV1;
}

export interface RubricGradeReport {
  /** False for anything but a `report`-type deliverable -- 07 restricts
   * the rubric grader to those. */
  applicable: boolean;
  passed: boolean;
  notes: string;
}

export interface RubricGrader {
  grade(input: RubricGradeInput): Promise<RubricGradeReport>;
}

/** V1's rubric grader: the interface is real, the grading is not. It never
 * fails a case, because a grader that does not exist must not be allowed to
 * turn into a silent gate. Wiring it to Handler B with the pinned
 * `brain/eval-rubric@1` prompt is its own future issue; until then this
 * makes the deferral explicit at the call site rather than leaving a hole
 * in the corpus report. */
export const deferredRubricGrader: RubricGrader = {
  async grade({ spec }: RubricGradeInput): Promise<RubricGradeReport> {
    const applicable = spec.contract.deliverable.type === "report";
    return {
      applicable,
      passed: true,
      notes: applicable
        ? "rubric grading deferred (07 section 7.11 cut line): deterministic grading only in V1"
        : "not applicable: rubric grading covers report-type deliverables only",
    };
  },
};

// --- running a case ------------------------------------------------------

export interface RunEvalCaseDeps {
  store: BrainStore;
  adapters: AdapterRegistry;
  workspacesRoot: string;
  journal?: RunJournal;
  rubricGrader?: RubricGrader;
}

export interface EvalCaseOutcome {
  caseId: string;
  passed: boolean;
  failures: string[];
  status: ResultContractV1["status"] | null;
  result: ResultContractV1 | null;
  rubric: RubricGradeReport | null;
  /** The synthetic run this execution created, so `brain logs <run_id>`
   * can explain a failure. Null when the case failed before a run row was
   * ever written (an unusable fixture, for instance). */
  runId: string | null;
  durationMs: number;
}

/** Re-dispatches one frozen case. task_id and run_id are minted fresh per
 * execution (a case file's own ids are placeholders) so the same case can
 * be run repeatedly against one store without colliding; `title` is passed
 * through UNCHANGED, which is what lets adapters/fixture.ts read a case's
 * scripted outcome back off the contract file dispatch writes to disk. */
export async function runEvalCase(loaded: LoadedEvalCase, deps: RunEvalCaseDeps): Promise<EvalCaseOutcome> {
  const { spec } = loaded;
  const startedMs = Date.now();
  let runId: string | null = null;
  const fail = (message: string): EvalCaseOutcome => ({
    caseId: spec.case_id,
    passed: false,
    failures: [message],
    status: null,
    result: null,
    rubric: null,
    runId,
    durationMs: Date.now() - startedMs,
  });

  let fixture: MaterializedFixture;
  try {
    fixture = materializeFixture(loaded);
  } catch (err) {
    return fail(`fixture could not be materialized: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    runId = randomUUID();
    const taskId = randomUUID();
    const contract: TaskContractV1 = {
      ...spec.contract,
      task_id: taskId,
      run_id: runId,
      repo: { url: fixture.repoUrl, ref: fixture.repoRef },
    };

    const contractValidation = validateTaskContract(contract);
    if (!contractValidation.valid) {
      return fail(`contract failed brain.task.v1 validation after id rewrite:\n  ${contractValidation.errors.join("\n  ")}`);
    }

    const now = new Date().toISOString();
    const run: Run = {
      id: runId,
      objective: `[eval] ${spec.case_id}`,
      autonomy: contract.autonomy,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    const task: Task = {
      id: taskId,
      runId,
      title: contract.title,
      status: "pending",
      contractJson: JSON.stringify(contract),
      resultJson: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      finishedAt: null,
    };
    deps.store.insertRun(run);
    deps.store.insertTask(task);

    // worktree.ts's createWorktree() runs `git clone --bare` WITH this as
    // its cwd and takes its repo lock inside it, so it has to exist before
    // the first case runs -- the daemon gets a mounted /workspaces volume,
    // but an eval run's scratch root is created on the fly.
    mkdirSync(deps.workspacesRoot, { recursive: true });

    const dispatch = createDispatchFn(deps.store, {
      adapters: deps.adapters,
      workspacesRoot: deps.workspacesRoot,
      journal: deps.journal,
    });

    try {
      await dispatch(task);
    } catch (err) {
      // createDispatchFn is documented never to throw; if it does, that is
      // itself the regression the corpus exists to catch, so it is
      // reported as a case failure rather than crashing the whole run.
      return fail(`dispatch threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    const finished = deps.store.getTask(taskId);
    if (!finished?.resultJson) {
      return fail("dispatch completed but wrote no brain.result.v1 for the task");
    }
    const result = JSON.parse(finished.resultJson) as ResultContractV1;

    const grade = gradeDeterministic(spec.expected, result);
    const rubric = await (deps.rubricGrader ?? deferredRubricGrader).grade({ spec, result });

    return {
      caseId: spec.case_id,
      passed: grade.passed,
      failures: grade.failures,
      status: result.status,
      result,
      rubric,
      runId,
      durationMs: Date.now() - startedMs,
    };
  } finally {
    fixture.cleanup();
  }
}

// --- running the corpus --------------------------------------------------

export interface CorpusReport {
  total: number;
  passed: number;
  failed: number;
  cases: EvalCaseOutcome[];
}

/** Runs every case sequentially. Sequential rather than concurrent on
 * purpose: each case creates a real git worktree and really spawns its own
 * verify commands, and a deterministic gate is worth more than a faster
 * one. Cases are independent, so one failure never short-circuits the
 * rest -- an operator wants the whole picture from one run. */
export async function runEvalCorpus(cases: LoadedEvalCase[], deps: RunEvalCaseDeps): Promise<CorpusReport> {
  const outcomes: EvalCaseOutcome[] = [];
  for (const loaded of cases) {
    const outcome = await runEvalCase(loaded, deps);
    persistCaseOutcome(deps.store, loaded.spec, outcome);
    outcomes.push(outcome);
  }
  return {
    total: outcomes.length,
    passed: outcomes.filter((o) => o.passed).length,
    failed: outcomes.filter((o) => !o.passed).length,
    cases: outcomes,
  };
}

/** eval_case / eval_result (store.ts, 07 section 7.6's table list). The
 * case row is keyed by case_id and written once; every execution appends
 * its own eval_result row, so a case accumulates a pass/fail history
 * rather than overwriting it. */
function persistCaseOutcome(store: BrainStore, spec: EvalCaseSpec, outcome: EvalCaseOutcome): void {
  const now = new Date().toISOString();
  if (!store.getEvalCase(spec.case_id)) {
    store.insertEvalCase({ id: spec.case_id, name: spec.case_id, specJson: JSON.stringify(spec), createdAt: now });
  }
  store.insertEvalResult({
    id: randomUUID(),
    evalCaseId: spec.case_id,
    runId: outcome.runId,
    passed: outcome.passed,
    outputJson: JSON.stringify({ status: outcome.status, failures: outcome.failures, rubric: outcome.rubric, durationMs: outcome.durationMs }),
    recordedAt: now,
  });
}

// --- capture -------------------------------------------------------------

export interface CaptureParams {
  store: BrainStore;
  runId: string;
  caseId: string;
  casesDir?: string;
  taskId?: string;
}

export interface CaptureResult {
  filePath: string;
  spec: EvalCaseSpec;
}

/** `brain eval capture <run_id>` (07 section 7.11): freezes a real run's
 * contract, its repo state reference, and an expected-outcome block
 * derived from what actually happened, into a case file. The derived
 * expectation is a STARTING POINT the operator is meant to edit -- 07
 * calls it "operator-edited" for a reason: capturing a run that failed for
 * a bad reason would otherwise enshrine that failure as correct. */
export function captureEvalCase(params: CaptureParams): CaptureResult {
  const { store, runId, caseId } = params;
  const casesDir = params.casesDir ?? DEFAULT_CASES_DIR;

  const run = store.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);

  const tasks = store.listTasksForRun(runId);
  const task = params.taskId ? tasks.find((t) => t.id === params.taskId) : tasks[0];
  if (!task) throw new Error(params.taskId ? `task ${params.taskId} is not part of run ${runId}` : `run ${runId} has no tasks to capture`);
  if (!task.resultJson) throw new Error(`task ${task.id} has no result yet (status ${task.status}) -- only a finished task can be captured`);

  const contract = JSON.parse(task.contractJson) as TaskContractV1;
  const result = JSON.parse(task.resultJson) as ResultContractV1;

  const spec: EvalCaseSpec = {
    case_id: caseId,
    description: `Captured from run ${runId} (task ${task.id}). REVIEW BEFORE MERGING: the expected block below was derived from what this run actually did, which is not automatically what it should do. Pin the fixture ref to a commit sha if the upstream branch moves.`,
    contract,
    fixture: { kind: "git_ref", url: contract.repo.url, ref: contract.repo.ref },
    expected: {
      status: result.status,
      verdicts: result.verdicts.map((v) => ({ id: v.id, pass: v.pass })),
      // Headroom over the observed figure so ordinary run-to-run variance
      // does not fail the gate; the operator is expected to tighten or
      // loosen this deliberately.
      max_cost_usd: Number(((result.cost.usd_estimate ?? 0) * 1.25 + 0.01).toFixed(4)),
    },
  };

  const validation = validateEvalCase(spec);
  if (!validation.valid) {
    throw new Error(`captured case does not match brain.eval-case.v1:\n  ${validation.errors.join("\n  ")}`);
  }

  mkdirSync(casesDir, { recursive: true });
  const filePath = path.join(casesDir, `${caseId}${CASE_FILE_SUFFIX}`);
  if (existsSync(filePath)) throw new Error(`${filePath} already exists -- pick a different case id rather than silently overwriting a frozen case`);
  writeFileSync(filePath, `${JSON.stringify(spec, null, 2)}\n`);

  return { filePath, spec };
}
