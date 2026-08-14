/**
 * Autonomy levels A0-A3 and the always-approve list (07-brain-
 * architecture.md section 7.7). Pure decision functions -- approvals.ts
 * owns the state transitions (parking, TTL expiry, resolution) these
 * feed into.
 */
import type { TaskContractV1 } from "./contracts.ts";

export const AUTONOMY_PLAN = 0; // A0: produce plans/contracts/dry-runs; zero harness dispatch
export const AUTONOMY_READ = 1; // A1: dispatch tasks with no write deliverable only
export const AUTONOMY_EXECUTE = 2; // A2 (default): full task execution
export const AUTONOMY_CHAIN = 3; // A3: multi-task DAGs incl. auto-merge on green

export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, 07 section 7.7's stated default

const DEFAULT_BRANCH_NAMES = new Set(["main", "master"]);

/** A1's own boundary: "dispatch tasks whose contracts contain no write
 * deliverable (reports, reviews)". `report` is the one non-write
 * deliverable type in brain.task.v1 (contracts.ts); `commit`/`patch`
 * both write. */
export function hasWriteDeliverable(contract: TaskContractV1): boolean {
  return contract.deliverable.type !== "report";
}

/** Per-level gate ignoring the always-approve list (checked separately,
 * and independently of level -- 07 section 7.7: "Always requires an
 * explicit approval regardless of level"). */
export function autonomyPermits(contract: TaskContractV1, autonomy: number): boolean {
  if (autonomy <= AUTONOMY_PLAN) return false; // A0: zero harness dispatch, ever
  if (autonomy === AUTONOMY_READ) return !hasWriteDeliverable(contract);
  return true; // A2/A3: full task execution (A2 vs A3 differ only in multi-task
  // auto-chaining, which isn't a per-task dispatch gate -- there's no
  // multi-task DAG decomposition to gate yet, m4-09's planner is
  // single-task only).
}

export interface AlwaysApproveContext {
  /** Cumulative cost estimate recorded so far for the OWNING RUN (not
   * just this task) -- 07 section 7.7: "any task whose cumulative cost
   * estimate exceeds the per-run budget". */
  cumulativeCostUsd: number;
  perRunCeilingUsd: number;
  /** Empty = no restriction configured (07 doesn't specify what an
   * unconfigured allowlist means; treating it as "everything allowed"
   * rather than "everything blocked" matches every other Brain default
   * so far -- a deploy that wants this enforced sets it explicitly). */
  repoAllowlist: string[];
}

/** 07 section 7.7's always-approve list, minus the two conditions no
 * brain.task.v1 field can currently express at all (remote branch
 * deletion, repository settings changes -- there is no contract field
 * for either; a future contract extension would need its own check
 * here, not a guess today). Returns a human-readable reason, or null if
 * nothing in the list triggers. */
export function alwaysApproveReason(contract: TaskContractV1, ctx: AlwaysApproveContext): string | null {
  // Defense in depth: brain.task.v1's own schema already rejects
  // deliverable.branch === main/master at validation time (contracts.ts),
  // so a JOURNALED contract can never actually trigger this -- kept as an
  // explicit, truthful check rather than assuming the schema is the only
  // thing standing guard.
  if (DEFAULT_BRANCH_NAMES.has(contract.deliverable.branch)) {
    return `deliverable.branch "${contract.deliverable.branch}" is a default branch`;
  }
  if (contract.constraints.network === "open") {
    return "constraints.network is open";
  }
  if (ctx.cumulativeCostUsd > ctx.perRunCeilingUsd) {
    return `cumulative run cost $${ctx.cumulativeCostUsd.toFixed(2)} exceeds the per-run ceiling $${ctx.perRunCeilingUsd.toFixed(2)}`;
  }
  if (ctx.repoAllowlist.length > 0 && !ctx.repoAllowlist.includes(contract.repo.url)) {
    return `repo "${contract.repo.url}" is not in the configured allowlist`;
  }
  return null;
}

export interface ApprovalDecision {
  needsApproval: boolean;
  reason: string | null;
}

/** The one combined decision the scheduler acts on: the always-approve
 * list overrides autonomy level entirely (07: "regardless of level"); a
 * task the level itself doesn't permit also parks, with its own reason. */
export function determineApproval(contract: TaskContractV1, autonomy: number, ctx: AlwaysApproveContext): ApprovalDecision {
  const alwaysReason = alwaysApproveReason(contract, ctx);
  if (alwaysReason) return { needsApproval: true, reason: alwaysReason };
  if (!autonomyPermits(contract, autonomy)) {
    return { needsApproval: true, reason: `autonomy level ${autonomy} does not permit a task with this deliverable` };
  }
  return { needsApproval: false, reason: null };
}
