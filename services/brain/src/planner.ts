/**
 * Skeleton planner (m4-09's "Planner output validation" scope bullet):
 * builds ONE brain.task.v1 contract per submitted objective. Real
 * multi-task DAG decomposition -- an LLM-driven planning step over the
 * context index (07 section 7.6) -- is deliberately deferred; m4-09's own
 * acceptance criteria only exercise a single-task dry run end to end, and
 * the load-bearing part of this issue is the schema/validation/journaling
 * discipline, not decomposition intelligence. Same "skeleton now, harden
 * later" precedent m3-06/m4-05/m4-08 already established. A future
 * decomposition step can still emit multiple TaskContractV1 objects plus
 * task_edge rows through the exact same validate-then-journal path in
 * run-service.ts; nothing here assumes a single task.
 */
import { randomUUID } from "node:crypto";
import type { TaskContractV1 } from "./contracts.ts";

const DEFAULT_HARNESS_FALLBACK: string[] = ["claude-code"];
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_WALL_CLOCK_MIN = 60;
const DEFAULT_TOKEN_BUDGET = 500_000;
const DEFAULT_NETWORK = "provider-only";
// ADR-05: the Brain holds its own dedicated, isolated Anthropic key, kept
// in its own vault (kernel-contract.ts's allowedActions.vaultKeys), never
// Handler A's. Every dispatched task needs the harness child to receive it
// by name -- without this, m4-10's claude-code adapter would spawn a
// `claude` process with no credentials at all.
const DEFAULT_VAULT_KEYS: string[] = ["ANTHROPIC_API_KEY"];
const TITLE_MAX_LEN = 120;

export interface PlanObjectiveParams {
  runId: string;
  taskId: string;
  objective: string;
  repo: { url: string; ref: string };
  autonomy: number;
  harnessPreferred?: "claude-code" | "codex" | "gemini" | null;
  contextRefs?: string[];
  /** Already resolved/pinned "name@version" strings (see prompt-refs.ts);
   * this function does no network I/O of its own. */
  promptOrgRefs?: string[];
  acceptance?: TaskContractV1["acceptance"];
  /** m4-13's `brain run --budget-tokens N`. */
  tokenBudget?: number;
}

function truncateTitle(objective: string): string {
  if (objective.length <= TITLE_MAX_LEN) return objective;
  return `${objective.slice(0, TITLE_MAX_LEN - 3)}...`;
}

/** Builds a single-task brain.task.v1 contract. Does not validate or
 * journal it -- callers run the result through contracts.ts's
 * validateTaskContract before treating it as anything but a draft (see
 * run-service.ts's submitContract, the one place that actually happens). */
export function planObjective(params: PlanObjectiveParams): TaskContractV1 {
  return {
    task_id: params.taskId,
    run_id: params.runId,
    title: truncateTitle(params.objective),
    repo: params.repo,
    harness: { preferred: params.harnessPreferred ?? null, fallback: DEFAULT_HARNESS_FALLBACK },
    autonomy: params.autonomy,
    prompt: {
      objective: params.objective,
      context_refs: params.contextRefs ?? [],
      prompt_org_refs: params.promptOrgRefs ?? [],
    },
    constraints: {
      allowed_paths: ["**"],
      denied_paths: [],
      vault_keys: DEFAULT_VAULT_KEYS,
      max_turns: DEFAULT_MAX_TURNS,
      wall_clock_min: DEFAULT_WALL_CLOCK_MIN,
      token_budget: params.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
      network: DEFAULT_NETWORK,
    },
    acceptance: params.acceptance ?? [],
    deliverable: {
      // 07 section 7.7: push/draft_pr at autonomy >= 2.
      type: "commit",
      branch: `brain/${params.taskId}`,
      push: params.autonomy >= 2,
      draft_pr: params.autonomy >= 2,
    },
  };
}

export function newRunId(): string {
  return randomUUID();
}

export function newTaskId(): string {
  return randomUUID();
}
