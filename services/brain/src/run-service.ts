/**
 * The Brain's single "submit a run" service function (07 section 7.8: "All
 * three surfaces call the same internal service layer; none has private
 * capabilities."). The CLI's `brain run` (m4-09) is the only caller wired
 * up so far -- the HTTP/UI surfaces land in m4-13/14/15 -- but this is
 * deliberately the one code path they will all eventually share.
 *
 * BR-1 / crash-recovery discipline: contract validation happens BEFORE any
 * store write, so an invalid contract leaves zero trace -- "no run row in
 * a dispatchable state" per m4-09's own acceptance criteria means, most
 * simply, no run row at all. Once valid, the run row is journaled before
 * the task row, which is journaled before dispatch is ever considered; a
 * dry run stops right there. Real dispatch is the scheduler's job (m4-08's
 * Scheduler.tick), picked up once the daemon's own tick loop runs against
 * this task -- wiring a non-dry-run CLI path to that is m4-10/m4-13's job,
 * out of this issue's scope.
 */
import type { BrainStore } from "./store.ts";
import { validateTaskContract, type TaskContractV1 } from "./contracts.ts";
import { planObjective, newRunId, newTaskId, type PlanObjectiveParams } from "./planner.ts";
import type { RunJournal } from "./journal.ts";
import type { Run, Task } from "./types.ts";

export interface SubmitRunParams {
  objective: string;
  repo: { url: string; ref: string };
  autonomy?: number;
  harnessPreferred?: "claude-code" | "codex" | "gemini" | null;
  contextRefs?: string[];
  /** Already resolved/pinned by the caller (see prompt-refs.ts); this
   * module does no network I/O of its own. */
  promptOrgRefs?: string[];
  acceptance?: TaskContractV1["acceptance"];
  /** m4-13's `brain run --budget-tokens N`. */
  tokenBudget?: number;
}

export type SubmitRunResult =
  | { ok: true; run: Run; tasks: Task[]; contracts: TaskContractV1[] }
  | { ok: false; errors: string[] };

const DEFAULT_AUTONOMY = 0;

function buildContract(params: SubmitRunParams, runId: string, taskId: string): TaskContractV1 {
  const planParams: PlanObjectiveParams = {
    runId,
    taskId,
    objective: params.objective,
    repo: params.repo,
    autonomy: params.autonomy ?? DEFAULT_AUTONOMY,
    harnessPreferred: params.harnessPreferred,
    contextRefs: params.contextRefs,
    promptOrgRefs: params.promptOrgRefs,
    acceptance: params.acceptance,
    tokenBudget: params.tokenBudget,
  };
  return planObjective(planParams);
}

/** Schema-validates a contract and, only if valid, journals its run and
 * task rows. Shared by submitRun (planner-built contracts) and by any
 * future caller handing in an already-built contract (e.g. a fixture in
 * tests, or a later multi-task planner) -- both go through the exact same
 * validate-then-journal discipline. */
export function submitContract(store: BrainStore, contract: TaskContractV1, journal?: RunJournal): SubmitRunResult {
  const validation = validateTaskContract(contract);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }

  const now = new Date().toISOString();
  const run: Run = {
    id: contract.run_id,
    objective: contract.prompt.objective,
    autonomy: contract.autonomy,
    status: "planning",
    createdAt: now,
    updatedAt: now,
  };
  // BR-1: the run row is committed before any task or invocation row
  // exists (proved by scheduler.test.ts's own store-based assertions and,
  // at the integration level, by this issue's own verification: a
  // `count(*) from run where id=...` query succeeding before any
  // invocation row is ever inserted for it).
  store.insertRun(run);

  const task: Task = {
    id: contract.task_id,
    runId: contract.run_id,
    title: contract.title,
    status: "pending",
    contractJson: JSON.stringify(contract),
    resultJson: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  store.insertTask(task);

  journal?.append({ runId: run.id, kind: "run.submitted", taskId: task.id, objective: run.objective });

  return { ok: true, run, tasks: [task], contracts: [contract] };
}

/** Plans a single-task contract from a bare objective, then delegates to
 * submitContract. */
export function submitRun(store: BrainStore, params: SubmitRunParams, journal?: RunJournal): SubmitRunResult {
  const contract = buildContract(params, newRunId(), newTaskId());
  return submitContract(store, contract, journal);
}
