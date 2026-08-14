import * as React from "react";

import { cn } from "../lib/cn";
import { OperatorMessage, AgentMessage, ToolCallBlock, SystemRow } from "./transcript-blocks";
import type { OperatorMessageState, AgentMessageState, ToolCallStatus } from "./transcript-blocks";
import { ApprovalCard } from "./approval-card";
import type { ApprovalResolution, Evidence } from "./approval-machine";
import { shouldVirtualize, buildOffsets, computeVirtualRange } from "./virtualize";
import { initialAutoscrollState, onScroll, onNewContent, jumpToLatest } from "./autoscroll";

// The transcript itself (09 section 7.1's dominant center-column region;
// section 6's streaming/virtualization contract; section 7.3's interaction
// rules). Composes the block components, the pure virtualize.ts windowing
// math, and the pure autoscroll.ts pin/unpin state into one scroll
// container.

export type TranscriptItem =
  | { id: string; kind: "operator"; text: string; state?: OperatorMessageState }
  | { id: string; kind: "agent"; text: string; state?: AgentMessageState; errorMessage?: string }
  | {
      id: string;
      kind: "tool";
      toolName: string;
      summary: string;
      status: ToolCallStatus;
      durationMs?: number;
      detail?: string;
    }
  | { id: string; kind: "system"; text: string }
  | {
      id: string;
      kind: "approval";
      title: string;
      evidence: Evidence;
      scopeLine: string;
      expiresAt?: string;
      resolution: ApprovalResolution;
      resolvedAt?: string;
    };

interface TranscriptProps {
  items: readonly TranscriptItem[];
  onApprove?: (itemId: string) => void;
  onReject?: (itemId: string, reason?: string) => void;
  className?: string;
}

const ESTIMATED_ITEM_HEIGHT = 64;

function renderItem(
  item: TranscriptItem,
  onApprove: ((itemId: string) => void) | undefined,
  onReject: ((itemId: string, reason?: string) => void) | undefined
): React.ReactNode {
  switch (item.kind) {
    case "operator":
      return <OperatorMessage text={item.text} state={item.state} />;
    case "agent":
      return <AgentMessage text={item.text} state={item.state} errorMessage={item.errorMessage} />;
    case "tool":
      return (
        <ToolCallBlock
          toolName={item.toolName}
          summary={item.summary}
          status={item.status}
          durationMs={item.durationMs}
          detail={item.detail}
        />
      );
    case "system":
      return <SystemRow text={item.text} />;
    case "approval":
      return (
        <ApprovalCard
          title={item.title}
          evidence={item.evidence}
          scopeLine={item.scopeLine}
          expiresAt={item.expiresAt}
          resolution={item.resolution}
          resolvedAt={item.resolvedAt}
          onApprove={() => onApprove?.(item.id)}
          onReject={(reason) => onReject?.(item.id, reason)}
        />
      );
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function Transcript({ items, onApprove, onReject, className }: TranscriptProps) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const heightsRef = React.useRef<Map<string, number>>(new Map());
  const [, bumpMeasurement] = React.useReducer((c: number) => c + 1, 0);
  const [autoscrollState, setAutoscrollState] = React.useState(initialAutoscrollState);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewportHeight, setViewportHeight] = React.useState(0);
  const prevCountRef = React.useRef(items.length);

  const virtualize = shouldVirtualize(items.length);

  const heights = React.useMemo(
    () => items.map((item) => heightsRef.current.get(item.id) ?? ESTIMATED_ITEM_HEIGHT),
    [items]
  );
  const offsets = React.useMemo(() => buildOffsets(heights), [heights]);

  const range = virtualize
    ? computeVirtualRange({ offsets, scrollTop, viewportHeight })
    : { startIndex: 0, endIndex: items.length, offsetTop: 0, totalHeight: offsets[offsets.length - 1] ?? 0 };

  // Bottom-anchored: new content scrolls the container to bottom while
  // pinned, and only grows the "jump to latest" unseen count otherwise --
  // never disturbing the operator's own scroll position (09 section 6).
  React.useEffect(() => {
    const grew = items.length > prevCountRef.current;
    prevCountRef.current = items.length;
    if (!grew) return;
    if (autoscrollState.pinned) {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    } else {
      setAutoscrollState((state) => onNewContent(state));
    }
    // autoscrollState.pinned is read, not depended on, deliberately: this
    // effect must fire once per item-count change, not re-fire every time
    // scrolling itself flips `pinned` (that would fight the very scroll
    // event it's reacting to).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    setScrollTop(node.scrollTop);
    setAutoscrollState((state) =>
      onScroll(state, { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight })
    );
  }

  function handleJumpToLatest() {
    setAutoscrollState(jumpToLatest());
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  function measureItem(id: string, node: HTMLDivElement | null) {
    if (!node) return;
    const measured = node.getBoundingClientRect().height;
    if (measured > 0 && heightsRef.current.get(id) !== measured) {
      heightsRef.current.set(id, measured);
      bumpMeasurement();
    }
  }

  const visibleItems = items.slice(range.startIndex, range.endIndex);

  return (
    <div data-slot="transcript" className={cn("relative min-h-0 flex-1", className)}>
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        <div style={{ height: range.totalHeight, position: "relative" }}>
          <div
            style={{ position: "absolute", top: range.offsetTop, left: 0, right: 0 }}
            className="flex flex-col gap-2 p-3"
          >
            {visibleItems.map((item) => (
              <div key={item.id} ref={(node) => measureItem(item.id, node)} data-transcript-item-kind={item.kind}>
                {renderItem(item, onApprove, onReject)}
              </div>
            ))}
          </div>
        </div>
      </div>
      {autoscrollState.unseenCount > 0 && (
        <button
          type="button"
          onClick={handleJumpToLatest}
          data-slot="jump-to-latest"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-fg shadow-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {autoscrollState.unseenCount} new ↓
        </button>
      )}
    </div>
  );
}

export { Transcript };
