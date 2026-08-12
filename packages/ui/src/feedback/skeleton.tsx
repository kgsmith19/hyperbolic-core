import * as React from "react";

import { cn } from "../lib/cn";

/**
 * A placeholder that matches the final layout's dimensions (set width/height
 * via className), so completion causes zero shift. Gate visibility with
 * useDelayedVisible so it never flashes on fast loads.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-bg-subtle", className)}
      {...props}
    />
  );
}

/**
 * Gates a boolean so it only flips true after `active` has held continuously
 * for `delayMs`, and resets to false the instant `active` goes false.
 *
 * docs/planning/09-design-system.md section 4.4: "Skeletons appear only
 * after a 200ms delay to prevent flash on fast loads." Use it as:
 *   const showSkeleton = useDelayedVisible(isLoading);
 *   if (showSkeleton) return <Skeleton className="h-24 w-full" />;
 */
function useDelayedVisible(active: boolean, delayMs = 200): boolean {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return visible;
}

export { Skeleton, useDelayedVisible };
