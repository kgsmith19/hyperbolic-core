/**
 * DAG scheduler (07-brain-architecture.md section 7.6: "the scheduler
 * dispatches tasks whose parents reached a terminal success state") with
 * the N=2 concurrency cap (section 7.3/7.7). This module is
 * adapter-agnostic on purpose: m4-08's own scope excludes real harness
 * adapters (m4-10), so dispatch is an injected callback -- the acceptance
 * criterion itself says "unit test with fake adapters."
 */
import type { BrainStore } from "./store.ts";
import { TERMINAL_SUCCESS_TASK_STATUS } from "./types.ts";
import type { Task } from "./types.ts";

export const MAX_CONCURRENT_DISPATCH = 2;

/** A pending task is dispatchable once every parent edge points at a task
 * that reached succeeded (the one terminal-success state, 7.5: "Anything
 * else is failed/timeout/cancelled/interrupted"). A task with no parents
 * is dispatchable immediately. */
export function isDispatchable(store: BrainStore, task: Task): boolean {
  if (task.status !== "pending") return false;
  const parents = store.parentsOf(task.id);
  if (parents.length === 0) return true;
  return parents.every((edge) => {
    const parent = store.getTask(edge.parentTaskId);
    return parent?.status === TERMINAL_SUCCESS_TASK_STATUS;
  });
}

export interface DispatchFn {
  (task: Task): Promise<void>;
}

/** m4-12: consulted for every DAG-eligible task before it counts against
 * the concurrency budget. Returning `needsApproval: true` means the gate
 * itself already performed the parking side effect (approvals.ts's
 * parkForApproval -- journaled state transition to `awaiting_approval`);
 * the scheduler's only remaining job is to skip that task this tick
 * without consuming a slot or touching `running`. Kept as an injected
 * callback rather than a hard dependency on autonomy.ts/approvals.ts so
 * this module stays exactly as adapter/policy-agnostic as m4-08 left it
 * -- daemon.ts is what closes over store/config to build a real one. */
export interface ApprovalGate {
  (task: Task): Promise<{ needsApproval: boolean }>;
}

export class Scheduler {
  #store: BrainStore;
  #dispatch: DispatchFn;
  #approvalGate?: ApprovalGate;
  #inFlight = new Set<string>();
  #maxConcurrent: number;

  constructor(store: BrainStore, dispatch: DispatchFn, maxConcurrent = MAX_CONCURRENT_DISPATCH, approvalGate?: ApprovalGate) {
    this.#store = store;
    this.#dispatch = dispatch;
    this.#maxConcurrent = maxConcurrent;
    this.#approvalGate = approvalGate;
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  /** One scheduling pass: dispatches as many eligible pending tasks as the
   * remaining concurrency budget allows, across every run (a single
   * scheduler serves the whole daemon, not one run at a time -- 7.3's
   * "single process... capped at N=2 concurrent" is a daemon-wide cap).
   * A task the approval gate parks is skipped WITHOUT consuming budget --
   * 07 section 7.7: "independent DAG branches continue" while one task is
   * parked, which falls out naturally here since parked tasks just don't
   * enter the dispatched set at all, leaving the full budget for siblings
   * considered later in the same pass. */
  async tick(): Promise<Task[]> {
    const budget = this.#maxConcurrent - this.#inFlight.size;
    if (budget <= 0) return [];

    const pending = this.#store.listTasksByStatus("pending");
    const eligible = pending.filter((t) => !this.#inFlight.has(t.id) && isDispatchable(this.#store, t));

    const dispatched: Task[] = [];
    for (const task of eligible) {
      if (dispatched.length >= budget) break;

      if (this.#approvalGate) {
        const decision = await this.#approvalGate(task);
        if (decision.needsApproval) continue;
      }

      // journaled before side effects (7.3): the status transition commits
      // to the store BEFORE dispatch() ever runs the harness, so a crash
      // between these two lines still leaves an accurate 'running' row for
      // boot-time reconciliation to find.
      this.#inFlight.add(task.id);
      this.#store.updateTaskStatus(task.id, "running", new Date().toISOString(), { startedAt: new Date().toISOString() });
      dispatched.push({ ...task, status: "running" });
      // Deliberately not awaited here: tick() dispatches up to `budget`
      // tasks and returns immediately so the caller's own poll loop stays
      // responsive; completion releases the in-flight slot via release().
      void this.#run(task.id);
    }
    return dispatched;
  }

  async #run(taskId: string): Promise<void> {
    try {
      const task = this.#store.getTask(taskId);
      if (!task) return;
      await this.#dispatch(task);
    } catch (err) {
      // A rejected dispatch() must never (a) crash the daemon via an
      // unhandled rejection, since #run is deliberately fire-and-forget
      // from tick(), or (b) leave the task stuck in `running` forever.
      // The detailed failure taxonomy (transport/logic/timeout/orphaned,
      // 07 section 7.4) is the harness adapter's job (m4-10) to set via a
      // more specific status before it throws; this is the generic safety
      // net for whatever it didn't handle itself.
      const current = this.#store.getTask(taskId);
      if (current && current.status === "running") {
        const now = new Date().toISOString();
        this.#store.updateTaskStatus(taskId, "failed", now, {
          finishedAt: now,
          resultJson: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        });
      }
    } finally {
      this.#inFlight.delete(taskId);
    }
  }
}
