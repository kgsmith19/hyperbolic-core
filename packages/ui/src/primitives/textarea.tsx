import * as React from "react";

import { cn } from "../lib/cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // text-md (16px) on narrow viewports, not text-base (14px): iOS Safari
        // auto-zooms focused inputs under 16px, so the smaller size only
        // applies once md: gives us room to be denser.
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-border-strong bg-transparent px-2.5 py-2 text-md transition-colors outline-none placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-border-strong/50 disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 md:text-sm",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
