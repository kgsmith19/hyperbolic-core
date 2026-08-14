import * as React from "react";

import { cn } from "../lib/cn";

// 09 section 7.1 (Surface anatomy, Cost ticker row): "right end of the
// status strip | current run cost and weekly spend; sourced from `cost`
// events plus ACC's existing `GET /api/process/status` (tier, weekText)
// [VERIFIED: 05-b section 5 Spending row]; click opens the Spending
// surface." `weekText` arrives already formatted from that endpoint, so
// this component only formats the run-local total it accumulates from
// `cost` events itself.

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

interface CostTickerProps extends React.ComponentProps<"button"> {
  currentRunUsd: number;
  /** Pre-formatted, e.g. "$4.10 this week (Builder tier)" -- ACC's own weekText shape. */
  weeklySpendLabel?: string;
}

function CostTicker({ currentRunUsd, weeklySpendLabel, className, ...props }: CostTickerProps) {
  return (
    <button
      type="button"
      data-slot="cost-ticker"
      className={cn(
        "ml-auto flex items-center gap-1.5 rounded px-1.5 text-xs text-text-secondary outline-none hover:text-text focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      <span className="font-mono text-text">{USD.format(currentRunUsd)}</span>
      {weeklySpendLabel && <span className="text-text-muted">{weeklySpendLabel}</span>}
    </button>
  );
}

export { CostTicker };
