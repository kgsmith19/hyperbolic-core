import * as React from "react";
import { Check, ChevronRight, X } from "lucide-react";

import { cn } from "../lib/cn";
import { Button } from "../primitives/button";
import { Badge } from "../primitives/badge";
import { isTextInputTarget } from "../chrome/keyboard";
import {
  canApprove,
  mapApprovalKey,
  type ApprovalResolution,
  type Evidence,
} from "./approval-machine";

// The approval interaction pattern (docs/planning/09-design-system.md
// section 7.4): keyboard-first, evidence-explicit. The pure gate/keyboard
// rules live in approval-machine.ts (unit-tested there); this component is
// the DOM wiring around them -- the IntersectionObserver that turns
// "rendered on screen" into a fact, and the capture of `d`/`y`/`n` while the
// card itself has focus.

const RESOLUTION_LABEL: Record<Exclude<ApprovalResolution, "pending">, string> = {
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
};

interface ApprovalCardProps extends Omit<React.ComponentProps<"div">, "title"> {
  title: string;
  evidence: Evidence;
  /** The target repo/path this action would affect (09 section 7.4, "Anatomy": "scope line naming the target repo/path"). */
  scopeLine: string;
  expiresAt?: string;
  /** Resolution is controlled: the real approve/reject network call lives in the consuming app, which updates this prop once it resolves. Pending is the only state this component drives interaction for. */
  resolution: ApprovalResolution;
  resolvedAt?: string;
  onApprove: () => void;
  onReject: (reason?: string) => void;
}

function formatExpiry(expiresAt: string, now: number): string | null {
  const remainingMs = Date.parse(expiresAt) - now;
  if (Number.isNaN(remainingMs)) return null;
  if (remainingMs <= 0) return "expired";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}

function EvidencePanel({ evidence, onVisible }: { evidence: Evidence; onVisible: () => void }) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    // Fail-safe direction: no observer support means evidenceSeen simply
    // never becomes true, which keeps Approve disabled rather than granting
    // it -- see approval-machine.ts's own doc comment on this same point.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisible();
      },
      { threshold: 0.5 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onVisible]);

  return (
    <div
      ref={ref}
      data-slot="approval-evidence"
      data-kind={evidence.kind}
      className="max-h-64 overflow-auto rounded-md bg-bg-subtle p-2 font-mono text-xs whitespace-pre-wrap text-text-secondary"
    >
      {evidence.body}
    </div>
  );
}

function ApprovalCard({
  title,
  evidence,
  scopeLine,
  expiresAt,
  resolution,
  resolvedAt,
  onApprove,
  onReject,
  className,
  ...props
}: ApprovalCardProps) {
  const [evidenceExpanded, setEvidenceExpanded] = React.useState(
    () => evidenceAutoExpands(evidence)
  );
  const [evidenceSeen, setEvidenceSeen] = React.useState(false);
  const [reasonPromptOpen, setReasonPromptOpen] = React.useState(false);
  const [reasonText, setReasonText] = React.useState("");
  const reasonInputRef = React.useRef<HTMLInputElement | null>(null);

  const isPending = resolution === "pending";
  const state = { evidenceExpanded, evidenceSeen, resolution };
  const approveEnabled = canApprove(state);

  const now = useNow(isPending && expiresAt !== undefined);
  const expiryLabel = isPending && expiresAt ? formatExpiry(expiresAt, now) : null;

  const markEvidenceSeen = React.useCallback(() => setEvidenceSeen(true), []);

  function openReasonPrompt() {
    setReasonPromptOpen(true);
    setReasonText("");
  }

  function confirmReject() {
    onReject(reasonText.trim() === "" ? undefined : reasonText.trim());
    setReasonPromptOpen(false);
  }

  function cancelReject() {
    setReasonPromptOpen(false);
    setReasonText("");
  }

  React.useEffect(() => {
    if (reasonPromptOpen) reasonInputRef.current?.focus();
  }, [reasonPromptOpen]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!isPending) return;
    if (isTextInputTarget(event.target)) return; // the reason-prompt input owns its own keys
    const action = mapApprovalKey(event.nativeEvent);
    if (action === "toggle-evidence") {
      event.preventDefault();
      setEvidenceExpanded((expanded) => !expanded);
    } else if (action === "approve" && approveEnabled) {
      event.preventDefault();
      onApprove();
    } else if (action === "reject") {
      event.preventDefault();
      openReasonPrompt();
    }
  }

  if (!isPending) {
    return (
      <div
        data-slot="approval-card"
        data-resolution={resolution}
        className={cn(
          "flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-secondary",
          className
        )}
        {...props}
      >
        <Badge variant={resolution === "approved" ? "default" : "secondary"}>
          {RESOLUTION_LABEL[resolution]}
        </Badge>
        <span className="flex-1 truncate">{title}</span>
        {resolvedAt && <span className="text-xs text-text-muted">{resolvedAt}</span>}
      </div>
    );
  }

  return (
    <div
      data-slot="approval-card"
      data-resolution="pending"
      role="group"
      aria-label={title}
      onKeyDown={handleKeyDown}
      className={cn(
        "rounded-lg border-2 border-warn bg-surface p-3 text-sm text-text",
        className
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{title}</p>
        {expiryLabel && (
          <span className="shrink-0 font-mono text-xs text-text-muted" aria-live="off">
            {expiryLabel}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-text-secondary">{scopeLine}</p>

      <button
        type="button"
        onClick={() => setEvidenceExpanded((expanded) => !expanded)}
        aria-expanded={evidenceExpanded}
        className="mt-2 flex items-center gap-1 text-xs text-accent outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", evidenceExpanded && "rotate-90")} />
        Evidence <kbd className="font-mono text-text-muted">d</kbd>
      </button>
      {evidenceExpanded && (
        <div className="mt-1">
          <EvidencePanel evidence={evidence} onVisible={markEvidenceSeen} />
        </div>
      )}

      {reasonPromptOpen ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            ref={reasonInputRef}
            type="text"
            value={reasonText}
            onChange={(event) => setReasonText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                confirmReject();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelReject();
              }
            }}
            placeholder="Reason (optional)"
            className="h-8 flex-1 rounded-lg border border-border-strong bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <Button type="button" variant="ghost" size="sm" onClick={cancelReject}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={confirmReject}>
            Confirm
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" data-testid="approval-reject" variant="outline" size="sm" onClick={openReasonPrompt}>
            <X className="size-3.5" /> Reject <kbd className="font-mono text-text-muted">n</kbd>
          </Button>
          <Button type="button" data-testid="approval-approve" size="sm" disabled={!approveEnabled} onClick={onApprove}>
            <Check className="size-3.5" /> Approve <kbd className="font-mono opacity-70">y</kbd>
          </Button>
        </div>
      )}
    </div>
  );
}

function evidenceAutoExpands(evidence: Evidence): boolean {
  const lineCount = evidence.body === "" ? 0 : evidence.body.split("\n").length;
  return lineCount < 40;
}

export { ApprovalCard };
