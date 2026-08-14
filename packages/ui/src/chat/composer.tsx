import * as React from "react";
import { Square } from "lucide-react";

import { cn } from "../lib/cn";
import { Button } from "../primitives/button";
import { Select, SelectItem } from "../primitives/select";
import { Textarea } from "../primitives/textarea";

// 09 section 7.1 (Surface anatomy, Composer row): "multiline input (grows
// to 8 lines then scrolls), target/profile selector (mirrors StartWork's
// existing directive fields [VERIFIED: StartWork.tsx cwd/profile/text
// state]), send (Ctrl/Cmd+Enter), Stop button replaces Send while a run is
// active." Section 7.3: "Stop is a first-class action... always enabled
// (never blocked behind a pending mutation)"; disconnect behavior disables
// the composer with a reason after 10s offline.

export interface ComposerTarget {
  readonly value: string;
  readonly label: string;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  /** True while a run is active: swaps Send for Stop. */
  running: boolean;
  targets?: readonly ComposerTarget[];
  target?: string;
  onTargetChange?: (value: string) => void;
  /** e.g. "Reconnecting…" after 10s offline (09 section 7.3). Send is disabled with this reason shown; Stop is unaffected. */
  disabledReason?: string;
  placeholder?: string;
  className?: string;
}

function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  targets,
  target,
  onTargetChange,
  disabledReason,
  placeholder = "Message the run…",
  className,
}: ComposerProps) {
  const canSend = value.trim() !== "" && !disabledReason && !running;

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <div data-slot="composer" className={cn("flex flex-col gap-2 border-t border-border bg-bg p-3", className)}>
      {targets && targets.length > 0 && (
        <Select
          aria-label="Target"
          value={target}
          onChange={(event) => onTargetChange?.(event.target.value)}
          wrapperClassName="w-56"
          size="sm"
        >
          {targets.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {t.label}
            </SelectItem>
          ))}
        </Select>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          data-testid="composer-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={Boolean(disabledReason)}
          rows={1}
          className="max-h-[calc(var(--text-sm--line-height)*8+1rem)] flex-1 overflow-y-auto resize-none"
        />
        {running ? (
          <Button type="button" data-testid="composer-stop" variant="destructive" onClick={onStop}>
            <Square className="size-3.5" /> Stop
          </Button>
        ) : (
          <Button type="button" disabled={!canSend} onClick={onSend}>
            Send
          </Button>
        )}
      </div>
      {disabledReason && (
        <p data-testid="composer-disabled-reason" className="text-xs text-text-muted">
          {disabledReason}
        </p>
      )}
    </div>
  );
}

export { Composer };
