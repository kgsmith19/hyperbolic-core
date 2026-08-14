// Pure-logic tests for the m4-16 Brain run surface's event mapping and
// connection-state machine. No DOM, no network -- the fast, direct
// regression net; e2e/brain-run.spec.ts proves the same contract end to
// end against a real (stubbed) SSE stream.
import { describe, expect, it } from "vitest";
import type { BrainEvent } from "@hyperbolic/platform-client";
import {
  applyBrainEvent,
  applyLocalApprovalResolution,
  computeConnectionDisplayState,
  initialBrainRunState,
  OFFLINE_THRESHOLD_MS,
  reconnectDelayMs,
  taskTitleLookup,
  type BrainRunReducerState,
} from "./brain-run";

function event(overrides: Partial<BrainEvent> & { kind: string }): BrainEvent {
  return { runId: "run-1", ts: "2026-08-14T00:00:00.000Z", ...overrides } as BrainEvent;
}

const noTitle = () => undefined;

describe("applyBrainEvent: real journal event kinds -> transcript items", () => {
  it("run.submitted appends a system row", () => {
    const state = applyBrainEvent(initialBrainRunState(), event({ kind: "run.submitted" }), 0, noTitle);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "system", text: "Run submitted" });
  });

  it("task.parked_for_approval creates a pending approval card using the task's title, reason, and expiry", () => {
    const titles = taskTitleLookup([{ id: "task-1", title: "Refactor the parser", runId: "run-1", status: "awaiting_approval", contractJson: "{}", resultJson: null, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null }]);
    const state = applyBrainEvent(
      initialBrainRunState(),
      event({ kind: "task.parked_for_approval", taskId: "task-1", reason: "write deliverable at autonomy 1", expiresAt: "2026-08-14T01:00:00.000Z" }),
      1,
      titles
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "approval-task-1",
      kind: "approval",
      title: "Refactor the parser",
      evidence: { kind: "text", body: "write deliverable at autonomy 1" },
      resolution: "pending",
      expiresAt: "2026-08-14T01:00:00.000Z",
    });
  });

  it("task.parked_for_approval without a known task title falls back to a generic title", () => {
    const state = applyBrainEvent(
      initialBrainRunState(),
      event({ kind: "task.parked_for_approval", taskId: "task-9", reason: "r" }),
      1,
      noTitle
    );
    expect((state.items[0] as { title: string }).title).toBe("Task requires approval");
  });

  it("a malformed task.parked_for_approval (missing taskId) is dropped, not crashed on", () => {
    const state = applyBrainEvent(initialBrainRunState(), event({ kind: "task.parked_for_approval", reason: "r" }), 1, noTitle);
    expect(state.items).toHaveLength(0);
  });

  it("task.approval_ttl_expired updates the SAME approval item's resolution to expired, not a new row", () => {
    let state = applyBrainEvent(
      initialBrainRunState(),
      event({ kind: "task.parked_for_approval", taskId: "task-1", reason: "r", expiresAt: "x" }),
      1,
      noTitle
    );
    state = applyBrainEvent(state, event({ kind: "task.approval_ttl_expired", taskId: "task-1" }), 2, noTitle);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ id: "approval-task-1", resolution: "expired" });
  });

  it("task.approval_ttl_expired for a task with no prior parked event still creates an expired card (defensive, not dropped)", () => {
    const state = applyBrainEvent(initialBrainRunState(), event({ kind: "task.approval_ttl_expired", taskId: "task-2" }), 1, noTitle);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ id: "approval-task-2", resolution: "expired" });
  });

  it.each([
    ["task.reattached", "Task reattached after a daemon restart"],
    ["task.resumed", "Task resumed"],
    ["task.harness_fallback", "Harness fallback engaged"],
  ])("%s appends the expected system row text", (kind, expectedText) => {
    const state = applyBrainEvent(initialBrainRunState(), event({ kind }), 1, noTitle);
    expect(state.items[0]).toMatchObject({ kind: "system", text: expectedText });
  });

  it("task.interrupted includes the reason when present", () => {
    const state = applyBrainEvent(initialBrainRunState(), event({ kind: "task.interrupted", reason: "shutdown_grace_expired" }), 1, noTitle);
    expect(state.items[0]).toMatchObject({ text: "Task interrupted (shutdown_grace_expired)" });
  });

  it("task.interrupted with no reason omits the parenthetical", () => {
    const state = applyBrainEvent(initialBrainRunState(), event({ kind: "task.interrupted" }), 1, noTitle);
    expect(state.items[0]).toMatchObject({ text: "Task interrupted" });
  });

  it("an unrecognized future kind still renders as a system row -- forward compatible, never silently dropped", () => {
    const state = applyBrainEvent(initialBrainRunState(), event({ kind: "harness.delta" }), 1, noTitle);
    expect(state.items[0]).toMatchObject({ kind: "system", text: "harness.delta" });
  });

  it("events use the SSE id as a stable row id, so replaying the same id is idempotent-shaped (same id, not a duplicate append site)", () => {
    const state = applyBrainEvent(initialBrainRunState(), event({ kind: "run.submitted" }), 5, noTitle);
    expect(state.items[0]!.id).toBe("event-5");
  });

  it("appending events accumulates in order without disturbing earlier rows", () => {
    let state = initialBrainRunState();
    state = applyBrainEvent(state, event({ kind: "run.submitted" }), 0, noTitle);
    state = applyBrainEvent(state, event({ kind: "task.resumed" }), 1, noTitle);
    expect(state.items.map((i) => (i as { text?: string }).text)).toEqual(["Run submitted", "Task resumed"]);
  });
});

describe("applyLocalApprovalResolution: the operator's own approve/reject click", () => {
  function pendingState(): BrainRunReducerState {
    return applyBrainEvent(
      initialBrainRunState(),
      event({ kind: "task.parked_for_approval", taskId: "task-1", reason: "r" }),
      1,
      noTitle
    );
  }

  it("approving flips the card's resolution to approved", () => {
    const state = applyLocalApprovalResolution(pendingState(), "task-1", "approved");
    expect(state.items[0]).toMatchObject({ resolution: "approved" });
  });

  it("rejecting flips the card's resolution to rejected", () => {
    const state = applyLocalApprovalResolution(pendingState(), "task-1", "rejected");
    expect(state.items[0]).toMatchObject({ resolution: "rejected" });
  });

  it("resolving a taskId with no existing card is a safe no-op-shaped default, not a crash", () => {
    const state = applyLocalApprovalResolution(initialBrainRunState(), "task-404", "approved");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ id: "approval-task-404", resolution: "approved" });
  });
});

describe("computeConnectionDisplayState (09 section 7.3: 10s offline threshold)", () => {
  it("live is always live, regardless of disconnectedAtMs", () => {
    expect(computeConnectionDisplayState("live", 12345, 99999)).toBe("live");
  });

  it("reconnecting with no disconnect timestamp yet reads as reconnecting", () => {
    expect(computeConnectionDisplayState("reconnecting", null, 1000)).toBe("reconnecting");
  });

  it("reconnecting stays reconnecting just under the 10s threshold", () => {
    const disconnectedAt = 0;
    expect(computeConnectionDisplayState("reconnecting", disconnectedAt, OFFLINE_THRESHOLD_MS - 1)).toBe("reconnecting");
  });

  it("reconnecting escalates to offline AT exactly the 10s threshold", () => {
    const disconnectedAt = 0;
    expect(computeConnectionDisplayState("reconnecting", disconnectedAt, OFFLINE_THRESHOLD_MS)).toBe("offline");
  });

  it("reconnecting escalates to offline well past the threshold", () => {
    expect(computeConnectionDisplayState("reconnecting", 0, OFFLINE_THRESHOLD_MS * 5)).toBe("offline");
  });

  it("a custom threshold is honored", () => {
    expect(computeConnectionDisplayState("reconnecting", 0, 4999, 5000)).toBe("reconnecting");
    expect(computeConnectionDisplayState("reconnecting", 0, 5000, 5000)).toBe("offline");
  });
});

describe("reconnectDelayMs: exponential backoff with a ceiling", () => {
  it("doubles each attempt from the base", () => {
    expect(reconnectDelayMs(0, 500, 10_000)).toBe(500);
    expect(reconnectDelayMs(1, 500, 10_000)).toBe(1000);
    expect(reconnectDelayMs(2, 500, 10_000)).toBe(2000);
    expect(reconnectDelayMs(3, 500, 10_000)).toBe(4000);
  });

  it("never exceeds the ceiling, however large the attempt count", () => {
    expect(reconnectDelayMs(20, 500, 10_000)).toBe(10_000);
  });

  it("clamps a negative attempt to zero (defensive)", () => {
    expect(reconnectDelayMs(-5, 500, 10_000)).toBe(500);
  });
});

describe("taskTitleLookup", () => {
  it("resolves a known task's title and returns undefined for an unknown one", () => {
    const lookup = taskTitleLookup([
      { id: "a", title: "Task A", runId: "r", status: "pending", contractJson: "{}", resultJson: null, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null },
    ]);
    expect(lookup("a")).toBe("Task A");
    expect(lookup("missing")).toBeUndefined();
  });
});
