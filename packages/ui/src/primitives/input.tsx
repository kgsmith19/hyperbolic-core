import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

import { cn } from "../lib/cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // text-md (16px) on narrow viewports, not text-base (14px): iOS Safari
        // auto-zooms focused inputs under 16px, so the smaller size only
        // applies once md: gives us room to be denser.
        "h-8 w-full min-w-0 rounded-lg border border-border-strong bg-transparent px-2.5 py-1 text-md transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-border-strong/50 disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 md:text-sm",
        className
      )}
      {...props}
    />
  );
}

export { Input };
