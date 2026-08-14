// The approval card's presentation state: pure functions, no React, no DOM.
// docs/planning/09-design-system.md section 7.4 ("Approval interaction
// pattern") owns every rule encoded here. Kept separate from
// approval-card.tsx (mirrors notifications/toast-machine.ts's split) so the
// evidence-gate and keyboard-mapping rules are directly unit-testable --
// packages/ui/test/approval.test.mjs, the exact file m4-15's own
// Verification section names.

export type EvidenceKind = "diff" | "command" | "text";

export interface Evidence {
  readonly kind: EvidenceKind;
  readonly body: string;
}

export type ApprovalResolution = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalCardState {
  readonly evidenceExpanded: boolean;
  readonly evidenceSeen: boolean;
  readonly resolution: ApprovalResolution;
}

/** 09 section 7.4: "expanded by default under 40 diff lines, explicit `d` toggle above". */
export const AUTO_EXPAND_LINE_THRESHOLD = 40;

export function countLines(body: string): number {
  return body === "" ? 0 : body.split("\n").length;
}

/**
 * `evidenceSeen` always starts false, regardless of `evidenceExpanded`:
 * expansion is a content decision, "seen" is a rendered-on-screen fact that
 * only the card's own IntersectionObserver can establish (see
 * approval-card.tsx) -- an evidence panel can be expanded yet still be
 * scrolled out of view in a long transcript.
 */
export function initialApprovalState(evidence: Evidence): ApprovalCardState {
  return {
    evidenceExpanded: countLines(evidence.body) < AUTO_EXPAND_LINE_THRESHOLD,
    evidenceSeen: false,
    resolution: "pending",
  };
}

/** Resolved cards are immutable (09 section 7.4, "Resolution": collapsed, stamped, done). */
function isPending(state: ApprovalCardState): boolean {
  return state.resolution === "pending";
}

export function toggleEvidence(state: ApprovalCardState): ApprovalCardState {
  if (!isPending(state)) return state;
  return { ...state, evidenceExpanded: !state.evidenceExpanded };
}

/** Idempotent: a panel already marked seen cannot be un-seen by a later observer callback. */
export function markEvidenceSeen(state: ApprovalCardState): ApprovalCardState {
  if (state.evidenceSeen) return state;
  return { ...state, evidenceSeen: true };
}

/**
 * 09 section 7.4, "Evidence gate": "the Approve control is disabled until
 * the evidence panel has been rendered on screen at least once... approving
 * unseen evidence is structurally impossible."
 */
export function canApprove(state: ApprovalCardState): boolean {
  return isPending(state) && state.evidenceSeen;
}

/** A no-op (not a throw) when the gate isn't open -- a stray Enter/click can never corrupt state. */
export function resolveApproved(state: ApprovalCardState): ApprovalCardState {
  if (!canApprove(state)) return state;
  return { ...state, resolution: "approved" };
}

export function resolveRejected(state: ApprovalCardState): ApprovalCardState {
  if (!isPending(state)) return state;
  return { ...state, resolution: "rejected" };
}

/** TTL expiry (07 section 7.7's approval TTL sweep) renders as expired-rejected (09 section 7.4). */
export function resolveExpired(state: ApprovalCardState): ApprovalCardState {
  if (!isPending(state)) return state;
  return { ...state, resolution: "expired" };
}

export type ApprovalKeyAction = "toggle-evidence" | "approve" | "reject" | null;

export interface ApprovalKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

/**
 * 09 section 7.4, "Keyboard": "with the card focused: `d` toggles evidence,
 * `y` approves, `n` rejects with an optional one-line reason prompt." Any
 * modifier held rules out every mapping -- these are bare single-key
 * shortcuts, not chords, so Cmd+D/Ctrl+Y etc. (browser/OS shortcuts) must
 * pass through untouched.
 */
export function mapApprovalKey(event: ApprovalKeyEvent): ApprovalKeyAction {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key.toLowerCase()) {
    case "d":
      return "toggle-evidence";
    case "y":
      return "approve";
    case "n":
      return "reject";
    default:
      return null;
  }
}
