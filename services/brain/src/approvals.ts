/**
 * Approval state transitions (07-brain-architecture.md section 7.7):
 * asynchronous parking, TTL expiry to cancelled with a journaled
 * rationale, and resolution (approve/reject). The approval UI card
 * (m4-15/m4-16) and CLI verbs (`brain approve <task>`, m4-13) are out of
 * this issue's scope -- this module owns the state and policy underneath
 * whatever surface eventually calls it.
 */
import { randomUUID } from "node:crypto";
import type { BrainStore } from "./store.ts";
import type { RunJournal } from "./journal.ts";
import type { Approval, Task } from "./types.ts";
import { DEFAULT_APPROVAL_TTL_MS } from "./autonomy.ts";

/** Parks a task pending approval: journaled before any side effect (there
 * is no side effect to perform here besides the state transition itself
 * -- parking IS the safe default, nothing to dispatch). Never re-parks a
 * task that already has a pending approval (idempotent per scheduler
 * tick -- scheduler.ts's own approval-gating call site is the guard,
 * this function trusts its caller not to call it twice for the same
 * still-pending approval). */
export function parkForApproval(store: BrainStore, journal: RunJournal | undefined, task: Task, reason: string, now: string, ttlMs: number = DEFAULT_APPROVAL_TTL_MS): void {
  const expiresAt = new Date(new Date(now).getTime() + ttlMs).toISOString();
  store.insertApproval({
    id: randomUUID(),
    taskId: task.id,
    reason,
    status: "pending",
    requestedAt: now,
    resolvedAt: null,
    expiresAt,
  });
  store.updateTaskStatus(task.id, "awaiting_approval", now);
  journal?.append({ runId: task.runId, kind: "task.parked_for_approval", taskId: task.id, reason, expiresAt });
}

/** An approval already on file (any status, not just pending) for this
 * task, most recent first -- lets the scheduler recognize "this exact
 * task was already approved" and stop re-parking it on every tick just
 * because the same always-approve condition still literally applies
 * (e.g. constraints.network is still "open" -- that never changes for a
 * given contract, so without this check an approved task would park
 * again the instant it went back to `pending`). */
export function latestApprovalFor(store: BrainStore, taskId: string): Approval | null {
  const approvals = store.listApprovalsForTask(taskId);
  return approvals.at(-1) ?? null;
}

export type ApprovalOutcome = "approved" | "rejected";

/** Resolves the latest PENDING approval for a task (keyed by task, not
 * approval id -- the natural key for an operator-facing verb like
 * `brain approve <task>`, m4-13's job to expose). Approved: the task
 * returns to `pending` so the scheduler's normal DAG eligibility
 * (isDispatchable) picks it up again next tick -- determineApproval()
 * will re-run, but latestApprovalFor finding this now-"approved" row is
 * what keeps it from re-parking. Rejected: the task moves straight to
 * `cancelled` (an operator saying no is a final answer, not something
 * worth leaving `pending` to be reconsidered). Returns false, changing
 * nothing, if the task has no pending approval to resolve. */
export function resolveApproval(store: BrainStore, journal: RunJournal | undefined, taskId: string, outcome: ApprovalOutcome, now: string): boolean {
  const pending = store.listApprovalsForTask(taskId).find((a) => a.status === "pending");
  if (!pending) return false;

  const task = store.getTask(taskId);
  store.updateApprovalStatus(pending.id, outcome, now);
  if (outcome === "approved") {
    store.updateTaskStatus(taskId, "pending", now);
  } else {
    store.updateTaskStatus(taskId, "cancelled", now, { finishedAt: now });
  }
  // task_id is a foreign key to task(id), so `task` is never actually
  // null for a real approval row; the fallback exists only to satisfy
  // JournalEventBase's non-nullable runId without asserting.
  journal?.append({ runId: task?.runId ?? "unknown", kind: `task.approval_${outcome}`, taskId, approvalId: pending.id });
  return true;
}

/** TTL sweep (07 section 7.7: "an unapproved task expires to cancelled
 * after a configurable TTL... with its rationale journaled"). Callers
 * inject `now` (never Date.now() internally) so a test can move the
 * clock forward deterministically rather than actually sleeping 7 days. */
export function sweepExpiredApprovals(store: BrainStore, journal: RunJournal | undefined, now: string): number {
  const nowMs = new Date(now).getTime();
  let expiredCount = 0;
  for (const approval of store.listPendingApprovals()) {
    if (new Date(approval.expiresAt).getTime() > nowMs) continue;
    store.updateApprovalStatus(approval.id, "expired", now);
    const task = store.getTask(approval.taskId);
    store.updateTaskStatus(approval.taskId, "cancelled", now, { finishedAt: now });
    journal?.append({
      runId: task?.runId ?? "unknown",
      kind: "task.approval_ttl_expired",
      taskId: approval.taskId,
      approvalId: approval.id,
      rationale: `approval TTL expired at ${approval.expiresAt} (reason was: ${approval.reason})`,
    });
    expiredCount += 1;
  }
  return expiredCount;
}
