// m4-15's own Verification section names this file explicitly: "node --test
// packages/ui/test/approval.test.mjs (evidence-gate and key cases)". Pure
// TypeScript, no JSX -- imported straight from source like
// notifications.test.mjs, for the same reasons (no build step to go stale,
// and the internal state machine has no reason to widen the public entry).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const machine = await import("../src/chat/approval-machine.ts");

const {
  AUTO_EXPAND_LINE_THRESHOLD,
  countLines,
  initialApprovalState,
  toggleEvidence,
  markEvidenceSeen,
  canApprove,
  resolveApproved,
  resolveRejected,
  resolveExpired,
  mapApprovalKey,
} = machine;

// ---------------------------------------------------------------------
// countLines / initialApprovalState -- 09 section 7.4: "expanded by
// default under 40 diff lines, explicit `d` toggle above".
// ---------------------------------------------------------------------

describe("countLines", () => {
  test("empty body is zero lines", () => {
    assert.equal(countLines(""), 0);
  });

  test("a single line with no newline is one line", () => {
    assert.equal(countLines("just one line"), 1);
  });

  test("counts newline-delimited lines", () => {
    assert.equal(countLines("a\nb\nc"), 3);
  });
});

describe("initialApprovalState (auto-expand threshold)", () => {
  test("the threshold is exactly 40", () => {
    assert.equal(AUTO_EXPAND_LINE_THRESHOLD, 40);
  });

  test("evidence under 40 lines starts expanded", () => {
    const evidence = { kind: "diff", body: Array.from({ length: 39 }, (_, i) => `line ${i}`).join("\n") };
    assert.equal(initialApprovalState(evidence).evidenceExpanded, true);
  });

  test("evidence at exactly 40 lines does NOT auto-expand", () => {
    const evidence = { kind: "diff", body: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") };
    assert.equal(initialApprovalState(evidence).evidenceExpanded, false);
  });

  test("evidence over 40 lines requires the explicit `d` toggle", () => {
    const evidence = { kind: "diff", body: Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") };
    assert.equal(initialApprovalState(evidence).evidenceExpanded, false);
  });

  test("evidenceSeen always starts false, even when auto-expanded -- expansion is not visibility", () => {
    const evidence = { kind: "text", body: "short" };
    const state = initialApprovalState(evidence);
    assert.equal(state.evidenceExpanded, true);
    assert.equal(state.evidenceSeen, false);
  });

  test("resolution always starts pending", () => {
    assert.equal(initialApprovalState({ kind: "command", body: "ls" }).resolution, "pending");
  });
});

// ---------------------------------------------------------------------
// The evidence gate itself -- 09 section 7.4: "the Approve control is
// disabled until the evidence panel has been rendered on screen at least
// once... approving unseen evidence is structurally impossible."
// ---------------------------------------------------------------------

describe("evidence gate", () => {
  test("canApprove is false before the evidence panel has been seen", () => {
    const state = initialApprovalState({ kind: "text", body: "x" });
    assert.equal(canApprove(state), false);
  });

  test("canApprove is true once evidence has been marked seen", () => {
    const seen = markEvidenceSeen(initialApprovalState({ kind: "text", body: "x" }));
    assert.equal(canApprove(seen), true);
  });

  test("markEvidenceSeen is idempotent -- a second call does not change an already-seen state", () => {
    const once = markEvidenceSeen(initialApprovalState({ kind: "text", body: "x" }));
    const twice = markEvidenceSeen(once);
    assert.deepEqual(twice, once);
  });

  test("resolveApproved is a no-op when the gate is not open -- unseen evidence cannot be approved", () => {
    const unseen = initialApprovalState({ kind: "text", body: "x" });
    const attempted = resolveApproved(unseen);
    assert.equal(attempted.resolution, "pending");
    assert.deepEqual(attempted, unseen);
  });

  test("resolveApproved succeeds once evidence has been seen", () => {
    const seen = markEvidenceSeen(initialApprovalState({ kind: "text", body: "x" }));
    const approved = resolveApproved(seen);
    assert.equal(approved.resolution, "approved");
  });

  test("rejection never requires the evidence gate -- always available while pending", () => {
    const unseen = initialApprovalState({ kind: "text", body: "x" });
    const rejected = resolveRejected(unseen);
    assert.equal(rejected.resolution, "rejected");
  });

  test("toggling evidence does not itself mark it seen", () => {
    const collapsed = initialApprovalState({ kind: "diff", body: Array.from({ length: 100 }, () => "x").join("\n") });
    assert.equal(collapsed.evidenceExpanded, false);
    const expanded = toggleEvidence(collapsed);
    assert.equal(expanded.evidenceExpanded, true);
    assert.equal(expanded.evidenceSeen, false);
    assert.equal(canApprove(expanded), false);
  });

  test("toggleEvidence flips expanded state back and forth", () => {
    const state = initialApprovalState({ kind: "text", body: "x" });
    assert.equal(toggleEvidence(toggleEvidence(state)).evidenceExpanded, state.evidenceExpanded);
  });
});

// ---------------------------------------------------------------------
// Resolved cards are immutable -- 09 section 7.4, "Resolution": "resolved
// cards persist in the transcript, collapsed, stamped with the resolution
// and timestamp."
// ---------------------------------------------------------------------

describe("resolution is terminal", () => {
  test("toggling evidence on a resolved card is a no-op", () => {
    const approved = resolveApproved(markEvidenceSeen(initialApprovalState({ kind: "text", body: "x" })));
    assert.deepEqual(toggleEvidence(approved), approved);
  });

  test("rejecting an already-approved card is a no-op", () => {
    const approved = resolveApproved(markEvidenceSeen(initialApprovalState({ kind: "text", body: "x" })));
    assert.deepEqual(resolveRejected(approved), approved);
  });

  test("approving an already-rejected card is a no-op", () => {
    const rejected = resolveRejected(initialApprovalState({ kind: "text", body: "x" }));
    const seen = markEvidenceSeen(rejected);
    assert.deepEqual(resolveApproved(seen), seen);
  });

  test("expiring an already-resolved card is a no-op -- expiry cannot override a real decision", () => {
    const rejected = resolveRejected(initialApprovalState({ kind: "text", body: "x" }));
    assert.deepEqual(resolveExpired(rejected), rejected);
  });

  test("expiring a pending card renders expired (09: 'expiry renders as expired-rejected')", () => {
    const expired = resolveExpired(initialApprovalState({ kind: "text", body: "x" }));
    assert.equal(expired.resolution, "expired");
  });
});

// ---------------------------------------------------------------------
// Keyboard mapping -- 09 section 7.4, "Keyboard": "with the card focused:
// `d` toggles evidence, `y` approves, `n` rejects with an optional
// one-line reason prompt."
// ---------------------------------------------------------------------

describe("mapApprovalKey", () => {
  test("d maps to toggle-evidence", () => {
    assert.equal(mapApprovalKey({ key: "d" }), "toggle-evidence");
  });

  test("y maps to approve", () => {
    assert.equal(mapApprovalKey({ key: "y" }), "approve");
  });

  test("n maps to reject", () => {
    assert.equal(mapApprovalKey({ key: "n" }), "reject");
  });

  test("mapping is case-insensitive", () => {
    assert.equal(mapApprovalKey({ key: "D" }), "toggle-evidence");
    assert.equal(mapApprovalKey({ key: "Y" }), "approve");
    assert.equal(mapApprovalKey({ key: "N" }), "reject");
  });

  test("every other key maps to null", () => {
    for (const key of ["a", "Enter", "Escape", " ", "Tab", "1"]) {
      assert.equal(mapApprovalKey({ key }), null);
    }
  });

  test("a held modifier rules out every mapping -- browser/OS shortcuts (Cmd+D, Ctrl+Y, ...) pass through untouched", () => {
    assert.equal(mapApprovalKey({ key: "d", metaKey: true }), null);
    assert.equal(mapApprovalKey({ key: "y", ctrlKey: true }), null);
    assert.equal(mapApprovalKey({ key: "n", altKey: true }), null);
  });
});
