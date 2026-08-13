"use client";

import * as React from "react";
import { Search, Wrench } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "../lib/cn";
import { ZONE_ENTRIES, shouldNavigateClientSide, type NavigateAdapter, type Zone } from "./zones";
import { paletteMatch } from "./palette-match";
import type { ToolPaletteEntry } from "./tool-entry";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeZone: Zone;
  /**
   * Registry-sourced tool entries (m3-04, 05-a section 5: "tool entries
   * enumerated from the Toolbelt registry"). Optional and defaults to
   * empty so every existing caller (and this file's own SSR-based tests)
   * keeps working unchanged.
   */
  tools?: readonly ToolPaletteEntry[];
  /**
   * Finding #70 (PR #8 security review): optional client-side navigation
   * adapter, identical contract to nav-rail.tsx's own `navigate` prop.
   * Applied ONLY to "navigation"-kind results (the ZONE_ENTRIES half) --
   * "tool"-kind results are registry-sourced hrefs this package has no way
   * to know are even internal to the consuming app's own router (m3-04's
   * own doc comment: packages/ui has no dependency on the registry client
   * that produced them), so they deliberately keep today's plain-anchor
   * behavior regardless of whether `navigate` is supplied.
   */
  navigate?: NavigateAdapter;
}

// Finding #74 (PR #8 security review): shared between the results <ul>'s
// own id and the input's aria-controls, so the two can never drift apart.
const RESULTS_LIST_ID = "command-palette-list";

type PaletteResult = {
  /** Stable React key AND the itemRefs map key -- unique across BOTH kinds. */
  key: string;
  kind: "navigation" | "tool";
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** "navigation" entries only, for the "Current" badge. */
  zone?: Zone;
  /** "navigation" entries only -- see zones.ts's ZoneEntry.hardNavigate. */
  hardNavigate?: boolean;
};

// Static half of the combined result list (05-a section 5; 09 section 4.2):
// the six zone entries, unchanged from before m3-04. Hoisted to module scope
// -- ZONE_ENTRIES never changes -- so only the registry-sourced half needs
// recomputing per render.
const NAVIGATION_RESULTS: PaletteResult[] = ZONE_ENTRIES.map((entry) => ({
  key: `zone:${entry.zone}`,
  kind: "navigation",
  label: entry.label,
  href: entry.href,
  icon: entry.icon,
  zone: entry.zone,
  hardNavigate: entry.hardNavigate,
}));

/**
 * Navigation-and-tools command palette (05-a section 5; 09 section 4.2).
 * Through m2-01/m2-02/m2-03, scope was deliberately closed to just the six
 * static zone entries below (no actions, no tool entries, no chat). m3-04
 * is the extension point those issues' own comments named in advance: a
 * second array of registry-sourced entries, concatenated in before the
 * `.filter(paletteMatch)` call, tagged `data-kind="tool"` instead of
 * `"navigation"`. Chat entries remain out of scope (m4-15) -- data-kind is
 * a closed two-value union, not an open string, so that boundary stays
 * structurally enforced, not just documented.
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
function CommandPalette({ open, onOpenChange, activeZone, tools, navigate }: CommandPaletteProps) {
  const [query, setQuery] = React.useState("");
  const [highlighted, setHighlighted] = React.useState(0);
  const itemRefs = React.useRef(new Map<string, HTMLAnchorElement>());

  const toolResults = React.useMemo<PaletteResult[]>(
    () =>
      (tools ?? []).map((tool) => ({
        key: `tool:${tool.id}`,
        kind: "tool",
        label: tool.label,
        href: tool.href,
        icon: Wrench,
      })),
    [tools]
  );

  const allResults = React.useMemo(
    () => [...NAVIGATION_RESULTS, ...toolResults],
    [toolResults]
  );

  const results = React.useMemo(
    () => allResults.filter((entry) => paletteMatch(entry.label, query)),
    [allResults, query]
  );
  const highlightedEntry = results[highlighted] ?? results[0];

  // First result preselected (09 section 4.2, Interaction row), and reset
  // whenever the filtered set changes so a stale index from a longer
  // previous list can't point past the end of a shorter new one.
  React.useEffect(() => {
    setHighlighted(0);
  }, [query]);

  // Finding #74 (PR #8 security review): the query-keyed effect above only
  // fires when the query TEXT changes. Arrow-key to a non-zero index,
  // close WITHOUT changing the query, reopen -- the query never changed
  // across that close/reopen, so that effect never re-fires and the stale
  // index survives into the reopened palette. This second effect resets on
  // every OPEN transition too, independent of query, closing that gap.
  React.useEffect(() => {
    if (open) setHighlighted(0);
  }, [open]);

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
      if (highlightedEntry) itemRefs.current.get(highlightedEntry.key)?.click();
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
                // Finding #74 (PR #8 security review): the combobox/listbox
                // ARIA relationship was previously incomplete -- only
                // aria-activedescendant was present. role/aria-expanded/
                // aria-controls complete the standard combobox pattern
                // (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
                role="combobox"
                aria-expanded={open}
                aria-controls={RESULTS_LIST_ID}
                aria-activedescendant={
                  highlightedEntry ? `palette-item-${highlightedEntry.key}` : undefined
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleKeyDown}
                className="h-11 w-full bg-transparent text-md text-text outline-none placeholder:text-text-muted"
              />
            </div>
            <ul
              id={RESULTS_LIST_ID}
              data-slot="command-palette-list"
              role="listbox"
              aria-label="Navigation and tool results"
              className="max-h-80 overflow-y-auto p-1.5"
            >
              {results.length === 0 && (
                <li className="px-3 py-6 text-center text-sm text-text-secondary">
                  No matching zone or tool.
                </li>
              )}
              {results.map((entry, index) => {
                const Icon = entry.icon;
                const selected = index === highlighted;
                return (
                  <li key={entry.key} role="presentation">
                    <a
                      id={`palette-item-${entry.key}`}
                      ref={(el) => {
                        if (el) itemRefs.current.set(entry.key, el);
                        else itemRefs.current.delete(entry.key);
                      }}
                      href={entry.href}
                      role="option"
                      tabIndex={-1}
                      aria-selected={selected}
                      data-slot="command-palette-item"
                      data-kind={entry.kind}
                      data-zone={entry.zone}
                      data-selected={selected}
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={(event) => {
                        // Finding #70: only "navigation" (ZONE_ENTRIES)
                        // results are ever eligible for client-side routing
                        // -- see this component's own `navigate` doc
                        // comment for why "tool" results are excluded.
                        if (entry.kind === "navigation" && shouldNavigateClientSide(entry, navigate)) {
                          event.preventDefault();
                          navigate(entry.href);
                        }
                        onOpenChange(false);
                      }}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-text outline-none",
                        selected && "bg-accent-muted text-text"
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-text-secondary" />
                      <span className="flex-1">{entry.label}</span>
                      {entry.kind === "navigation" && entry.zone === activeZone && (
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
