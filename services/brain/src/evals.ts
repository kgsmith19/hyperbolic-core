/**
 * Eval harness (07-brain-architecture.md section 7.11, m4-19): case
 * format, capture flow, and the deterministic grader. "The Brain cannot
 * ship self-modifying orchestration without a regression net."
 *
 * Case format: `{case_id, description, contract: brain.task.v1, fixture:
 * {repo_tar or git ref}, expected: {status, verdicts, max_cost_usd}}`.
 * V1 gap, documented not silently dropped: `fixture.repo_tar` (a frozen,
 * packed repo snapshot) is schema-supported but capture() never
 * populates it -- only `fixture.git_ref` (re-dispatch the contract's own
 * repo at a resolvable ref) is actually wired up. A future issue that
 * needs a case whose repo state must never drift with the live ref can
 * add repo_tar packing/unpacking behind this same field without a
 * schema change.
 *
 * Grading is deterministic only in V1 (07's own cut line: "Rubric grader
 * only for report-type deliverables... secondary"); the LLM rubric
 * grader is out of this issue's scope, stubbed behind nothing yet since
 * no report-type case exists to need it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { ValidateFunction } from "ajv";
import { compileValidator, formatErrors, validateTaskContract, type TaskContractV1, type ResultContractV1, type ValidationResult } from "./contracts.ts";
import { submitContract } from "./run-service.ts";
import { newRunId, newTaskId } from "./planner.ts";
import { createDispatchFn, type DispatchDeps } from "./dispatch.ts";
import type { BrainStore } from "./store.ts";
import type { RunJournal } from "./journal.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASE_SCHEMA_PATH = join(__dirname, "schemas", "brain.eval-case.v1.schema.json");

/** m6-01: a seed case that wants to exercise a real `git clone` (worktree.ts's
 * own createWorktree -- no eval case dispatches against a mocked repo)
 * without depending on network reachability or a credential for this
 * repo's own remote -- PR-gate CI has neither (10-cicd-deployment.md
 * section 6). `contract.repo.url === "self"` resolves, at dispatch time,
 * to the actual on-disk root of the checkout currently running this code
 * -- three levels up from services/brain/src, the same computation
 * config.ts's own `repoRoot` makes -- so `git clone --bare` clones the
 * exact commit under test with zero network dependency, in every
 * environment (sandbox, CI runner, any dev machine) alike. */
const SELF_REPO_SENTINEL = "self";

function resolveRepoUrl(url: string): string {
  return url === SELF_REPO_SENTINEL ? resolve(__dirname, "..", "..", "..") : url;
}

export interface EvalCaseFile {
  case_id: string;
  description: string;
  contract: TaskContractV1;
  fixture: { repo_tar: string | null; git_ref: string | null };
  expected: {
    status: ResultContractV1["status"];
    verdicts?: Array<{ id: string; pass: boolean }>;
    max_cost_usd?: number | null;
  };
}

let caseValidator: ValidateFunction | undefined;

/** Validates the case envelope AND (only once the envelope itself is
 * valid) the embedded contract through contracts.ts's own
 * validateTaskContract -- the single source of truth for brain.task.v1,
 * never duplicated here as a second schema. */
export function validateEvalCase(caseObj: unknown): ValidationResult {
  caseValidator ??= compileValidator(CASE_SCHEMA_PATH);
  const envelopeValid = caseValidator(caseObj) as boolean;
  if (!envelopeValid) {
    return { valid: false, errors: formatErrors(caseValidator) };
  }
  const contractValidation = validateTaskContract((caseObj as EvalCaseFile).contract);
  if (!contractValidation.valid) {
    return { valid: false, errors: contractValidation.errors.map((e) => `contract: ${e}`) };
  }
  return { valid: true, errors: [] };
}

export interface LoadedCase {
  file: string;
  case: EvalCaseFile | null;
  errors: string[];
}

/** Every `*.case.json` in `dir`, parsed and schema-validated -- an
 * unparseable or schema-invalid file is reported (`errors` non-empty,
 * `case: null`), never silently skipped: a broken case in the corpus is
 * itself a regression the gate should catch. Missing directory (no
 * corpus yet, V1's own state until m6-01 seeds it) returns []. */
export function loadCasesFromDir(dir: string): LoadedCase[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".case.json"))
    .sort();
  return files.map((file) => {
    const full = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      return { file, case: null, errors: [`unparseable JSON: ${err instanceof Error ? err.message : String(err)}`] };
    }
    const validation = validateEvalCase(parsed);
    return { file, case: validation.valid ? (parsed as EvalCaseFile) : null, errors: validation.errors };
  });
}

export interface GradeResult {
  pass: boolean;
  reasons: string[];
}

/** Deterministic grader (07 section 7.11): "compare status + verdicts +
 * cost ceiling." `expected.verdicts` is a subset check -- every listed
 * {id, pass} must match the fresh result's own verdict for that id
 * exactly; a verdict id the case doesn't mention is not checked, so a
 * case can pin only the criteria it actually cares about. */
export function gradeResult(expected: EvalCaseFile["expected"], actual: ResultContractV1): GradeResult {
  const reasons: string[] = [];
  if (actual.status !== expected.status) {
    reasons.push(`status: expected "${expected.status}", got "${actual.status}"`);
  }
  for (const ev of expected.verdicts ?? []) {
    const av = actual.verdicts.find((v) => v.id === ev.id);
    if (!av) reasons.push(`verdict ${ev.id}: expected present, missing from result`);
    else if (av.pass !== ev.pass) reasons.push(`verdict ${ev.id}: expected pass=${ev.pass}, got pass=${av.pass}`);
  }
  if (expected.max_cost_usd !== null && expected.max_cost_usd !== undefined) {
    const usd = actual.cost.usd_estimate;
    if (usd !== null && usd > expected.max_cost_usd) {
      reasons.push(`cost: $${usd} exceeds ceiling $${expected.max_cost_usd}`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

export interface EvalCaseOutcome {
  case_id: string;
  file: string;
  pass: boolean;
  reasons: string[];
  actual: ResultContractV1 | null;
  runId: string;
}

/** Re-dispatches one case's contract through the REAL dispatch pipeline
 * (createDispatchFn -- the same code path a live run takes, not a
 * replay/mock), under a fresh run_id/task_id so the same case can be run
 * repeatedly against one store without a primary-key collision, then
 * grades the fresh result against `expected`. `deps.adapters` decides
 * what's "real": production wiring (bin/brain.mjs) passes real harness
 * adapters; a corpus with zero seed cases (V1's own state, m6-01's job
 * to populate) never actually exercises this against a live credential. */
export async function runEvalCase(store: BrainStore, journal: RunJournal | undefined, deps: DispatchDeps, loaded: LoadedCase): Promise<EvalCaseOutcome> {
  if (!loaded.case) {
    return { case_id: loaded.file, file: loaded.file, pass: false, reasons: loaded.errors, actual: null, runId: "" };
  }
  const caseFile = loaded.case;
  const runId = newRunId();
  const taskId = newTaskId();
  const repo = caseFile.fixture.git_ref ? { ...caseFile.contract.repo, ref: caseFile.fixture.git_ref } : caseFile.contract.repo;
  const contract: TaskContractV1 = {
    ...caseFile.contract,
    run_id: runId,
    task_id: taskId,
    repo: { ...repo, url: resolveRepoUrl(repo.url) },
  };

  const submitted = submitContract(store, contract, journal);
  if (!submitted.ok) {
    return { case_id: caseFile.case_id, file: loaded.file, pass: false, reasons: [`contract failed schema validation: ${submitted.errors.join("; ")}`], actual: null, runId };
  }

  const dispatch = createDispatchFn(store, deps);
  await dispatch(submitted.tasks[0]!);

  const finalTask = store.getTask(taskId)!;
  if (!finalTask.resultJson) {
    return { case_id: caseFile.case_id, file: loaded.file, pass: false, reasons: [`task ${taskId} produced no result`], actual: null, runId };
  }
  const actual = JSON.parse(finalTask.resultJson) as ResultContractV1;
  const graded = gradeResult(caseFile.expected, actual);
  return { case_id: caseFile.case_id, file: loaded.file, pass: graded.pass, reasons: graded.reasons, actual, runId };
}

export type CaptureResult = { ok: true; path: string; caseFile: EvalCaseFile } | { ok: false; errors: string[] };

/** `brain eval capture <run_id>` (07 section 7.11): "freezes a real run
 * (contract + repo state before dispatch + expected-from-actual outcome,
 * operator-edited) into a case." The captured `max_cost_usd` is a
 * starting ceiling with 50% margin over what was actually observed, not
 * a promise of exactness -- 07's own "operator-edited" wording expects a
 * human to review the written file before it joins the corpus, same as
 * every other issue's own "process rule: every S1/S2 failure must
 * produce a case before its fix merges" workflow. */
export function captureEvalCase(store: BrainStore, casesDir: string, runId: string, caseId: string, description: string): CaptureResult {
  const run = store.getRun(runId);
  if (!run) return { ok: false, errors: [`run ${runId} not found`] };
  const task = store.listTasksForRun(runId)[0];
  if (!task) return { ok: false, errors: [`run ${runId} has no tasks to capture`] };
  if (!task.resultJson) return { ok: false, errors: [`task ${task.id} has not finished yet (no result)`] };

  const contract = JSON.parse(task.contractJson) as TaskContractV1;
  const result = JSON.parse(task.resultJson) as ResultContractV1;
  const margin = result.cost.usd_estimate === null ? null : Math.round((result.cost.usd_estimate * 1.5 + 0.01) * 1e6) / 1e6;

  const caseFile: EvalCaseFile = {
    case_id: caseId,
    description,
    contract,
    fixture: { repo_tar: null, git_ref: contract.repo.ref },
    expected: {
      status: result.status,
      verdicts: result.verdicts.map((v) => ({ id: v.id, pass: v.pass })),
      max_cost_usd: margin,
    },
  };

  const validation = validateEvalCase(caseFile);
  if (!validation.valid) return { ok: false, errors: validation.errors };

  mkdirSync(casesDir, { recursive: true });
  const filePath = join(casesDir, `${caseId}.case.json`);
  writeFileSync(filePath, `${JSON.stringify(caseFile, null, 2)}\n`);

  store.insertEvalCase({ id: caseId, name: description, specJson: JSON.stringify(caseFile), createdAt: new Date().toISOString() });

  return { ok: true, path: filePath, caseFile };
}
