import * as React from "react";
import { CheckCircle2, ChevronRight, XCircle } from "lucide-react";

import { cn } from "../lib/cn";
import { Spinner } from "../feedback/spinner";
import { InlineError } from "../feedback/inline-error";

// Transcript block anatomy (docs/planning/09-design-system.md section 7.2)
// and interaction rules (section 7.3). Four of the five block kinds in that
// table live here; the fifth (Approval card) is its own module,
// approval-card.tsx, per section 7.4.

/** Splits `text` on backtick-delimited spans and wraps each in `<code>`, per section 7.2's "mono for code spans". Deliberately not a full markdown renderer -- no markdown dependency exists in this package yet, and pulling one in is a scope decision beyond primitives; headers/lists/bold are plain text until that lands. */
function renderWithInlineCode(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) =>
    part.length > 1 && part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded bg-bg-subtle px-1 py-0.5 font-mono text-xs">
        {part.slice(1, -1)}
      </code>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  );
}

export type OperatorMessageState = "sent" | "sending";

interface OperatorMessageProps extends React.ComponentProps<"div"> {
  text: string;
  state?: OperatorMessageState;
}

/** 09 section 7.2: "plain text on --color-surface, right-aligned accent edge"; "sending" is optimistic and subdued until acked. */
function OperatorMessage({ text, state = "sent", className, ...props }: OperatorMessageProps) {
  return (
    <div data-slot="operator-message" data-state={state} className={cn("flex justify-end", className)} {...props}>
      <div
        className={cn(
          "max-w-[70ch] rounded-lg border-r-2 border-accent bg-surface px-3 py-2 text-sm whitespace-pre-wrap text-text",
          state === "sending" && "opacity-60"
        )}
      >
        {text}
      </div>
    </div>
  );
}

export type AgentMessageState = "streaming" | "complete" | "error";

interface AgentMessageProps extends React.ComponentProps<"div"> {
  text: string;
  state?: AgentMessageState;
  errorMessage?: string;
}

/** 09 section 7.2: streamed text, markdown rendered progressively, mono for code spans; error-terminated gets a danger edge plus an inline error. */
function AgentMessage({ text, state = "complete", errorMessage, className, ...props }: AgentMessageProps) {
  return (
    <div
      data-slot="agent-message"
      data-state={state}
      className={cn(
        "max-w-[70ch] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap text-text",
        state === "error" && "border-l-2 border-danger",
        className
      )}
      {...props}
    >
      <span>{renderWithInlineCode(text)}</span>
      {state === "streaming" && (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse bg-text align-middle"
        />
      )}
      {state === "error" && errorMessage && <InlineError message={errorMessage} className="mt-2" />}
    </div>
  );
}

export type ToolCallStatus = "running" | "ok" | "failed";

const STATUS_ICON: Record<ToolCallStatus, React.ReactNode> = {
  running: <Spinner className="size-3.5" />,
  ok: <CheckCircle2 className="size-3.5 text-success" />,
  failed: <XCircle className="size-3.5 text-danger" />,
};

/** 09 section 6: "expanded raw output above 500 lines renders tail-first with an explicit 'load earlier output' step." */
const TAIL_LINE_THRESHOLD = 500;
const INITIAL_TAIL_LINES = 200;

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

interface ToolCallBlockProps extends Omit<React.ComponentProps<"div">, "children"> {
  toolName: string;
  summary: string;
  status: ToolCallStatus;
  durationMs?: number;
  detail?: string;
  /** Omit for an uncontrolled block that manages its own expansion (still auto-expanding on failure); the parent transcript is expected to persist expansion state per block for the session (09 section 7.3) when it wants that across re-renders. */
  expanded?: boolean;
  onToggleExpanded?: (expanded: boolean) => void;
}

/** 09 section 7.2/7.3: collapsed summary row reserves its height before content lands (CLS 0); a failed call auto-expands; collapsed-by-default otherwise. */
function ToolCallBlock({
  toolName,
  summary,
  status,
  durationMs,
  detail,
  expanded,
  onToggleExpanded,
  className,
  ...props
}: ToolCallBlockProps) {
  const isControlled = expanded !== undefined;
  const [localExpanded, setLocalExpanded] = React.useState(status === "failed");
  const isExpanded = isControlled ? expanded : localExpanded;
  const [showFullOutput, setShowFullOutput] = React.useState(false);
  const prevStatusRef = React.useRef(status);

  React.useEffect(() => {
    if (!isControlled && status === "failed" && prevStatusRef.current !== "failed") {
      setLocalExpanded(true);
    }
    prevStatusRef.current = status;
  }, [status, isControlled]);

  function toggle() {
    const next = !isExpanded;
    if (isControlled) onToggleExpanded?.(next);
    else setLocalExpanded(next);
  }

  const lines = detail ? detail.split("\n") : [];
  const isLong = lines.length > TAIL_LINE_THRESHOLD;
  const visibleLines = isLong && !showFullOutput ? lines.slice(-INITIAL_TAIL_LINES) : lines;

  return (
    <div
      data-slot="tool-call-block"
      data-status={status}
      data-expanded={isExpanded}
      className={cn("rounded-lg border border-border bg-surface text-sm", className)}
      {...props}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isExpanded}
        className="flex h-9 w-full items-center gap-2 px-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {STATUS_ICON[status]}
        <span className="font-medium text-text">{toolName}</span>
        <span className="flex-1 truncate text-text-secondary">{summary}</span>
        {durationMs !== undefined && (
          <span className="font-mono text-xs text-text-muted">{formatDurationMs(durationMs)}</span>
        )}
        <ChevronRight className={cn("size-4 shrink-0 text-text-muted transition-transform", isExpanded && "rotate-90")} />
      </button>
      {isExpanded && detail !== undefined && (
        <div className="border-t border-border px-3 py-2">
          {isLong && !showFullOutput && (
            <button
              type="button"
              onClick={() => setShowFullOutput(true)}
              className="mb-2 text-xs text-accent underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Load earlier output ({lines.length - INITIAL_TAIL_LINES} more lines)
            </button>
          )}
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-text-secondary">
            {visibleLines.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

interface SystemRowProps extends React.ComponentProps<"div"> {
  text: string;
}

/** 09 section 7.2: "single muted line (run started, lane acquired, reconnected)". */
function SystemRow({ text, className, ...props }: SystemRowProps) {
  return (
    <div data-slot="system-row" className={cn("px-3 py-1 text-center text-xs text-text-muted", className)} {...props}>
      {text}
    </div>
  );
}

export { OperatorMessage, AgentMessage, ToolCallBlock, SystemRow };
