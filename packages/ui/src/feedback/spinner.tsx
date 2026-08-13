import * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "../lib/cn";

/**
 * Indeterminate inline spinner for an operation tied to a control (button
 * pending state, palette search). Never use for a full-page loading state --
 * prefer Skeleton wherever the final layout is already known, and never pair
 * the two for the same operation (docs/planning/09-design-system.md section
 * 4.4).
 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
