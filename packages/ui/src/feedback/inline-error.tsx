import * as React from "react";
import { AlertCircle } from "lucide-react";

import { cn } from "../lib/cn";
import { Button } from "../primitives/button";

interface InlineErrorProps extends React.ComponentProps<"div"> {
  message: string;
  /** Retries the failing action in place. Omit if there is nothing to retry. */
  onRetry?: () => void;
}

/**
 * Mutation and validation failures render adjacent to the triggering
 * control, in --color-danger, with the failing action retryable in place
 * (docs/planning/09-design-system.md section 4.4, "Error, inline").
 */
function InlineError({
  message,
  onRetry,
  className,
  ...props
}: InlineErrorProps) {
  return (
    <div
      data-slot="inline-error"
      role="alert"
      className={cn("flex items-center gap-2 text-sm text-danger", className)}
      {...props}
    >
      <AlertCircle className="size-4 shrink-0" />
      <span>{message}</span>
      {onRetry && (
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export { InlineError };
