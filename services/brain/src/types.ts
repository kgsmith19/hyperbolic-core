/**
 * Shared types for the Brain daemon (07-brain-architecture.md section 7.6's
 * table list; sections 7.5/7.7 for the field names below). The task
 * contract's OWN schema (brain.task.v1) is m4-09's job -- this file stores
 * it as opaque JSON (`contractJson`) rather than a typed shape, so m4-09
 * can land its schema without a breaking change here.
 */

export type RunStatus = "planning" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted";

/** Terminal statuses per 7.5: "Anything else is failed, timeout, cancelled,
 * or interrupted" (succeeded is the one terminal-success state). */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "timeout", "cancelled", "interrupted"]);
export const TERMINAL_SUCCESS_TASK_STATUS: TaskStatus = "succeeded";

export type TaskEdgeKind = "sequence" | "verify" | "derived";

export interface Run {
  id: string;
  objective: string;
  autonomy: number;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  runId: string;
  title: string;
  status: TaskStatus;
  /** The brain.task.v1 contract, opaque here (m4-09 owns its schema). */
  contractJson: string;
  resultJson: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskEdge {
  parentTaskId: string;
  childTaskId: string;
  kind: TaskEdgeKind;
}

export type InvocationStatus = "running" | "resumed" | "completed" | "failed" | "orphaned";

export interface Invocation {
  id: string;
  taskId: string;
  harness: string;
  sessionId: string | null;
  status: InvocationStatus;
  startedAt: string;
  finishedAt: string | null;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  taskId: string;
  reason: string;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
  expiresAt: string;
}

export interface Cost {
  id: string;
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  usdEstimate: number | null;
  recordedAt: string;
}

export interface EvalCase {
  id: string;
  name: string;
  specJson: string;
  createdAt: string;
}

export interface EvalResult {
  id: string;
  evalCaseId: string;
  runId: string | null;
  passed: boolean;
  outputJson: string;
  recordedAt: string;
}
