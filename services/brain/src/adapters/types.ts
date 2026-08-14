/**
 * HarnessAdapter interface -- frozen in V1, stubs allowed (07-brain-
 * architecture.md section 7.4's own TS block, copied verbatim except for
 * doc comments). claude-code.ts is the one adapter that "ships complete"
 * (spawns the ACC kernel as a subprocess); stub.ts's codex/gemini adapters
 * always report unavailable, per this issue's own scope.
 */

export type HarnessId = "claude-code" | "codex" | "gemini";

export interface ProbeResult {
  ok: boolean;
  version: string;
}

/** The kernel (and the stub adapters, symmetrically) run start-to-finish
 * inside a single start()/resume() call -- there is no separate "poll for
 * completion" step in V1, so a resolved HarnessSession always carries a
 * terminal outcome. `raw` is the adapter's own raw result payload (the
 * kernel's parsed stdout JSON for claude-code); result-mapper.ts is the
 * one place that interprets it, so this type stays adapter-agnostic. */
export interface HarnessSession {
  sessionId: string;
  outcome: "accepted" | "rejected" | "aborted-by-budget" | "failed-to-start" | "refused" | "orphaned";
  raw: unknown;
}

/** The minimal slice of a Task/contract an adapter needs to start a run --
 * decoupled from services/brain's own Task/TaskContractV1 types so this
 * interface stays exactly what 07 section 7.4 froze, not whatever shape
 * this package's store happens to use internally. */
export interface AdapterInvocation {
  invocationId: string;
  taskId: string;
  runId: string;
  /** Absolute path to a brain.task.v1 JSON contract file on disk. */
  contractPath: string;
  /** Absolute path to the task's git worktree (07 section 7.4: one
   * worktree per task, created before dispatch). */
  worktreePath: string;
  wallClockMinBudget: number;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  probe(): Promise<ProbeResult>;
  start(inv: AdapterInvocation): Promise<HarnessSession>;
  resume(sessionId: string, inv: AdapterInvocation): Promise<HarnessSession>;
  cancel(sessionId: string, deadlineMs: number): Promise<void>;
}
