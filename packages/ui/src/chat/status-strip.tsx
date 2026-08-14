import * as React from "react";

import { cn } from "../lib/cn";

// 09 section 7.1 (Surface anatomy, Status/health strip row): "top of center
// column, 32px | stream connection state (live/reconnecting/offline), lane
// status, harness process state, current run state; each segment
// click-through to its owning page."

export type ConnectionState = "live" | "reconnecting" | "offline";
export type RunState = "queued" | "running" | "awaiting_approval" | "done" | "failed" | "stopped";

const CONNECTION_DOT: Record<ConnectionState, string> = {
  live: "bg-success",
  reconnecting: "bg-warn",
  offline: "bg-danger",
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

interface StatusSegmentProps extends React.ComponentProps<"span"> {
  onClick?: () => void;
}

/** A segment renders as a real button when it has somewhere to click through to, a plain span otherwise -- never a fake-interactive element. */
function StatusSegment({ onClick, className, children, ...props }: StatusSegmentProps) {
  const shared = cn("truncate text-xs text-text-secondary", onClick && "hover:text-text", className);
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(shared, "outline-none focus-visible:ring-3 focus-visible:ring-ring/50 rounded")}
        {...(props as React.ComponentProps<"button">)}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={shared} {...props}>
      {children}
    </span>
  );
}

interface StatusStripProps {
  connectionState: ConnectionState;
  reconnectAttempt?: number;
  laneStatus?: string;
  harnessState?: string;
  runState?: RunState;
  onConnectionClick?: () => void;
  onLaneClick?: () => void;
  onHarnessClick?: () => void;
  onRunStateClick?: () => void;
  /** The CostTicker (or any trailing content) -- rendered at the strip's right end via `ml-auto` on its own root, so no extra wrapper is needed here. */
  costTicker?: React.ReactNode;
  className?: string;
}

function StatusStrip({
  connectionState,
  reconnectAttempt,
  laneStatus,
  harnessState,
  runState,
  onConnectionClick,
  onLaneClick,
  onHarnessClick,
  onRunStateClick,
  costTicker,
  className,
}: StatusStripProps) {
  return (
    <div
      data-slot="status-strip"
      className={cn("flex h-8 items-center gap-3 border-b border-border bg-bg px-3", className)}
    >
      <StatusSegment onClick={onConnectionClick} className="flex items-center gap-1.5">
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", CONNECTION_DOT[connectionState])} />
        {CONNECTION_LABEL[connectionState]}
        {connectionState === "reconnecting" && reconnectAttempt !== undefined && ` (${reconnectAttempt})`}
      </StatusSegment>
      {laneStatus && <StatusSegment onClick={onLaneClick}>{laneStatus}</StatusSegment>}
      {harnessState && <StatusSegment onClick={onHarnessClick}>{harnessState}</StatusSegment>}
      {runState && <StatusSegment onClick={onRunStateClick}>{runState.replace(/_/g, " ")}</StatusSegment>}
      {costTicker}
    </div>
  );
}

export { StatusStrip };
