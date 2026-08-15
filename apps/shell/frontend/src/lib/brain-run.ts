// Pure state for the Brain run surface (m4-16, docs/planning/issues/m4-16-
// feat-shell-brain-surface.md): mapping the Brain's REAL journal event
// kinds (services/brain/src/{run-service,approvals,daemon,dispatch}.ts --
// run.submitted, task.parked_for_approval, task.approval_ttl_expired,
// task.reattached, task.resumed, task.interrupted, task.harness_fallback)
// onto packages/ui's TranscriptItem shape, plus the connection-state/
// offline-timer machine 09-design-system.md section 7.3 specifies.
//
// Scope note, stated once here rather than scattered in comments below:
// the journal today carries only coarse task-lifecycle events, not the
// aspirational per-token/tool-call RunEvent stream 09 section 7's own
// consumption-contract comment describes ("Event names below are the UI's
// expectation and yield to 07's authoritative schema" -- and 07's schema
// itself has no real producer for message_start/token/tool_call yet, per
// m4-14's own PR notes). So this page cannot render a live agent chat
// transcript; it renders the real lifecycle it has, as system rows and
// approval cards, and every unrecognized future `kind` still renders (as a
// system row, generic but never silently dropped) so a new journal
// producer lighting up later needs no client change to become visible.
import type { BrainEvent, BrainTask } from "@hyperbolic/platform-client";
import type { TranscriptItem } from "@hyperbolic/ui";

export interface BrainRunReducerState {
  readonly items: readonly TranscriptItem[];
}

export function initialBrainRunState(): BrainRunReducerState {
  return { items: [] };
}

function approvalItemId(taskId: string): string {
  return `approval-${taskId}`;
}

function upsertItem(
  state: BrainRunReducerState,
  id: string,
  build: (existing: TranscriptItem | undefined) => TranscriptItem
): BrainRunReducerState {
  const idx = state.items.findIndex((item) => item.id === id);
  if (idx === -1) {
    return { items: [...state.items, build(undefined)] };
  }
  const items = state.items.slice();
  items[idx] = build(items[idx]);
  return { items };
}

function appendSystemRow(state: BrainRunReducerState, id: string, text: string): BrainRunReducerState {
  return { items: [...state.items, { id, kind: "system", text }] };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Folds one SSE-delivered journal event into the transcript. `eventId` is
 * the SSE `id:` field (the journal index) -- used as this item's stable id
 * for non-approval events so replay/resume never produces a duplicate row.
 * `taskTitle` looks up a task's human title for an approval card; the
 * caller supplies it from its own `getRun()`-fetched task list since the
 * journal event itself carries only `taskId`.
 */
export function applyBrainEvent(
  state: BrainRunReducerState,
  event: BrainEvent,
  eventId: number | null,
  taskTitle: (taskId: string) => string | undefined
): BrainRunReducerState {
  const rowId = eventId !== null ? `event-${eventId}` : `event-${event.kind}-${event.ts}`;
  switch (event.kind) {
    case "run.submitted":
      return appendSystemRow(state, rowId, "Run submitted");

    case "task.parked_for_approval": {
      const taskId = asString(event.taskId);
      if (!taskId) return state;
      const reason = asString(event.reason) ?? "";
      const expiresAt = asString(event.expiresAt);
      return upsertItem(state, approvalItemId(taskId), () => ({
        id: approvalItemId(taskId),
        kind: "approval",
        title: taskTitle(taskId) ?? "Task requires approval",
        evidence: { kind: "text", body: reason },
        scopeLine: reason,
        ...(expiresAt ? { expiresAt } : {}),
        resolution: "pending",
      }));
    }

    case "task.approval_ttl_expired": {
      const taskId = asString(event.taskId);
      if (!taskId) return state;
      const id = approvalItemId(taskId);
      return upsertItem(state, id, (existing) =>
        existing && existing.kind === "approval"
          ? { ...existing, resolution: "expired" }
          : {
              id,
              kind: "approval",
              title: taskTitle(taskId) ?? "Task requires approval",
              evidence: { kind: "text", body: "" },
              scopeLine: "",
              resolution: "expired",
            }
      );
    }

    case "task.reattached":
      return appendSystemRow(state, rowId, "Task reattached after a daemon restart");
    case "task.resumed":
      return appendSystemRow(state, rowId, "Task resumed");
    case "task.interrupted": {
      const reason = asString(event.reason);
      return appendSystemRow(state, rowId, reason ? `Task interrupted (${reason})` : "Task interrupted");
    }
    case "task.harness_fallback":
      return appendSystemRow(state, rowId, "Harness fallback engaged");

    default:
      // Forward-compatible: a future journal producer's new `kind` still
      // renders, never silently dropped -- see this file's header comment.
      return appendSystemRow(state, rowId, event.kind);
  }
}

/**
 * Applies the outcome of the operator's OWN approve/reject click. The
 * journal has no event kind for this (resolution is only ever journaled
 * client-side as approval-card state, not re-broadcast over SSE by the
 * server for the approving client itself), so the surface updates its own
 * card optimistically once the API call the click triggered has resolved.
 */
export function applyLocalApprovalResolution(
  state: BrainRunReducerState,
  taskId: string,
  resolution: "approved" | "rejected"
): BrainRunReducerState {
  const id = approvalItemId(taskId);
  return upsertItem(state, id, (existing) =>
    existing && existing.kind === "approval" ? { ...existing, resolution } : existing ?? {
      id,
      kind: "approval",
      title: "Task requires approval",
      evidence: { kind: "text", body: "" },
      scopeLine: "",
      resolution,
    }
  );
}

/** Builds the taskTitle lookup applyBrainEvent needs, from a run's task list (BrainClient.getRun's own shape). */
export function taskTitleLookup(tasks: readonly BrainTask[]): (taskId: string) => string | undefined {
  const byId = new Map(tasks.map((t) => [t.id, t.title] as const));
  return (taskId) => byId.get(taskId);
}

// --- Connection state (09 section 7.3: reconnect UX) ------------------

export type BrainConnectionState = "live" | "reconnecting" | "offline";

/** 09 section 7.3: "the transcript becomes visibly read-only (composer disabled with reason) after 10 s offline." */
export const OFFLINE_THRESHOLD_MS = 10_000;

/**
 * Pure: given when the connection was last known-good (`liveSinceOrLostAt`,
 * epoch ms) and the current connection attempt state, decides the
 * DISPLAYED state. `reconnecting` only escalates to `offline` once the
 * threshold has elapsed since the connection was lost -- a brief reconnect
 * blip never flips the composer to read-only.
 */
export function computeConnectionDisplayState(
  rawState: "live" | "reconnecting",
  disconnectedAtMs: number | null,
  nowMs: number,
  offlineThresholdMs: number = OFFLINE_THRESHOLD_MS
): BrainConnectionState {
  if (rawState === "live") return "live";
  if (disconnectedAtMs === null) return "reconnecting";
  return nowMs - disconnectedAtMs >= offlineThresholdMs ? "offline" : "reconnecting";
}

/** Exponential backoff with a ceiling, for the SSE reconnect loop. */
export function reconnectDelayMs(attempt: number, baseMs = 500, maxMs = 10_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
}
