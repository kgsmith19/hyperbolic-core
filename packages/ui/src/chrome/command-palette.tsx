"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "../lib/cn";
import { ZONE_ENTRIES, type Zone } from "./zones";
import { paletteMatch } from "./palette-match";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeZone: Zone;
}

/**
 * Navigation-only command palette (05-a section 5; 09 section 4.2). Scope
 * is deliberately closed: the six static zone entries below, nothing else
 * -- no actions, no tool entries, no chat, per this issue's own text.
 *
 * Extension point for m3-04 (explicitly NOT built here, per the m2-01 issue
 * text: "the palette should have a clean extension point for it, but do
 * not build the registry-fetching logic itself"): `results` below is
 * computed by filtering exactly one array, ZONE_ENTRIES. A registry-backed
 * version adds a second array of the same
 * `{ zone/id, label, href, icon }`-shaped entries, concatenates it in
 * before the `.filter(paletteMatch)` call, and tags each with
 * data-kind="tool" instead of "navigation" below. No other change to this
 * file should be required. ChromeProps (05-a section 7) is not extended
 * with a new prop for this now -- its signature is a closed, binding
 * 3-field contract, and speculatively growing it ahead of m3-04 actually
 * landing would be guessing at that issue's own shape.
 *
 * Built on @base-ui/react/dialog (the same primitive dialog.tsx already
 * uses, so this costs no new module-graph weight) rather than a bespoke
 * overlay: Base UI's Dialog already provides exactly what 09 section 4.3's
 * binding focus rule requires ("modal and palette focus is trapped and
 * returned on close") -- default `initialFocus` moves focus to the first
 * tabbable element (the search input below) and default `finalFocus`
 * restores "the trigger or previously focused element", which composes
 * correctly whether the palette was opened by the topbar button or by the
 * global Ctrl/Cmd+K listener (a controlled `open` prop, not a
 * Dialog.Trigger, either way -- verified in this issue's browser test).
 * Rendering deliberately differs from Dialog's own DialogContent: shadow-2
 * and surface-raised, not shadow-3, per 09 section 3.4's elevation table
 * ("--shadow-2 popover/dropdown/palette" vs "--shadow-3 modal").
 */
function CommandPalette({ open, onOpenChange, activeZone }: CommandPaletteProps) {
  const [query, setQuery] = React.useState("");
  const [highlighted, setHighlighted] = React.useState(0);
  const itemRefs = React.useRef(new Map<Zone, HTMLAnchorElement>());

  const results = React.useMemo(
    () => ZONE_ENTRIES.filter((entry) => paletteMatch(entry.label, query)),
    [query]
  );
  const highlightedEntry = results[highlighted] ?? results[0];

  // First result preselected (09 section 4.2, Interaction row), and reset
  // whenever the filtered set changes so a stale index from a longer
  // previous list can't point past the end of a shorter new one.
  React.useEffect(() => {
    setHighlighted(0);
  }, [query]);

  // Clear the search between opens so re-opening the palette never shows
  // the previous session's leftover query.
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (highlightedEntry) itemRefs.current.get(highlightedEntry.zone)?.click();
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="command-palette-backdrop"
          className="fixed inset-0 z-50 bg-overlay transition-opacity duration-base ease-standard data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[15vh]">
          <DialogPrimitive.Popup
            data-slot="command-palette"
            aria-label="Command palette"
            className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface-raised text-text shadow-2 outline-none transition-[opacity,transform] duration-base ease-standard data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0"
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 shrink-0 text-text-secondary" />
              <input
                data-slot="command-palette-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="Go to..."
                aria-label="Search navigation"
                aria-activedescendant={
                  highlightedEntry ? `palette-item-${highlightedEntry.zone}` : undefined
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleKeyDown}
                className="h-11 w-full bg-transparent text-md text-text outline-none placeholder:text-text-muted"
              />
            </div>
            <ul
              id="command-palette-list"
              data-slot="command-palette-list"
              role="listbox"
              aria-label="Navigation results"
              className="max-h-80 overflow-y-auto p-1.5"
            >
              {results.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-text-secondary">
                  No matching zone.
                </li>
              )}
              {results.map((entry, index) => {
                const Icon = entry.icon;
                const selected = index === highlighted;
                return (
                  <li key={entry.zone} role="presentation">
                    <a
                      id={`palette-item-${entry.zone}`}
                      ref={(el) => {
                        if (el) itemRefs.current.set(entry.zone, el);
                        else itemRefs.current.delete(entry.zone);
                      }}
                      href={entry.href}
                      role="option"
                      tabIndex={-1}
                      aria-selected={selected}
                      data-slot="command-palette-item"
                      data-kind="navigation"
                      data-zone={entry.zone}
                      data-selected={selected}
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={() => onOpenChange(false)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-text outline-none",
                        selected && "bg-accent-muted text-text"
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-text-secondary" />
                      <span className="flex-1">{entry.label}</span>
                      {entry.zone === activeZone && (
                        <span className="text-xs text-text-muted">Current</span>
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { CommandPalette };
