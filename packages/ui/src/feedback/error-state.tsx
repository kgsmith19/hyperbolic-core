import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { cn } from "../lib/cn";
import { Button } from "../primitives/button";

interface ErrorStateProps extends React.ComponentProps<"div"> {
  /** One sentence naming what failed. */
  title: string;
  /** The cause summary. */
  message?: string;
  onRetry?: () => void;
}

/**
 * Route data completely failed: full-content error state with the cause
 * summary and a retry action. Render this inside the content region only --
 * the chrome must still render around it (docs/planning/09-design-system.md
 * section 4.4, "Error, page-level").
 */
function ErrorState({
  title,
  message,
  onRetry,
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      data-slot="error-state"
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-border bg-danger-bg px-6 py-12 text-center",
        className
      )}
      {...props}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-surface text-danger [&>svg]:size-5">
        <AlertTriangle />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-medium text-text">{title}</p>
        {message && <p className="text-sm text-text-secondary">{message}</p>}
      </div>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export { ErrorState };
