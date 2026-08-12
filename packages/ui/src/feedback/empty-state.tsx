import * as React from "react";

import { cn } from "../lib/cn";

interface EmptyStateProps extends React.ComponentProps<"div"> {
  /** Illustrative icon, e.g. a lucide-react icon element. */
  icon: React.ReactNode;
  /** One sentence naming what will appear here. */
  title: string;
  /** The single primary action that creates the first item, or a link-out. */
  action?: React.ReactNode;
}

/**
 * Every list/collection surface ships a designed empty state: icon, one
 * sentence, one primary action (docs/planning/09-design-system.md section
 * 4.4). Bare "No data" text is a defect -- this component exists so that
 * defect is structurally hard to reach for.
 */
function EmptyState({
  icon,
  title,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center",
        className
      )}
      {...props}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-bg-subtle text-text-secondary [&>svg]:size-5">
        {icon}
      </div>
      <p className="max-w-sm text-sm text-text-secondary">{title}</p>
      {action}
    </div>
  );
}

export { EmptyState };
