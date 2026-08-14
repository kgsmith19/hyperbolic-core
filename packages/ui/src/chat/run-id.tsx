import * as React from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "../lib/cn";

interface RunIdProps extends Omit<React.ComponentProps<"button">, "onClick"> {
  id: string;
}

/**
 * 09 section 7.3: "Every id (run, directive, call) renders in `--font-mono`
 * with click-to-copy, matching ACC's existing id styling idiom [VERIFIED:
 * StartWork.tsx font-mono id span]". A real `<button>` (not a styled
 * `<span>` with a click handler) so the copy action is keyboard-reachable
 * and has a focus ring, same baseline every other interactive primitive in
 * this package gets.
 */
function RunId({ id, className, ...props }: RunIdProps) {
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      // Clipboard access can be denied (permissions, insecure context); the
      // id is still visible and selectable as plain text either way, so
      // this is silently non-fatal rather than surfacing an error state for
      // a convenience action.
      return;
    }
    setCopied(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      data-slot="run-id"
      onClick={handleClick}
      title={copied ? "Copied" : `Copy ${id}`}
      className={cn(
        "inline-flex items-center gap-1 rounded font-mono text-xs text-text-muted outline-none hover:text-text focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      {id}
      {copied ? <Check className="size-3" /> : <Copy className="size-3 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}

export { RunId };
