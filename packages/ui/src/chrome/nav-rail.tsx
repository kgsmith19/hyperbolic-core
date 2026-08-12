"use client";

import * as React from "react";
import { PanelLeftClose, PanelLeft } from "lucide-react";

import { cn } from "../lib/cn";
import { ZONE_ENTRIES, type Zone } from "./zones";

const EXPANDED_STORAGE_KEY = "hyperbolic-ui-nav-expanded";

function readInitialExpanded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // fall through to the viewport-based default below
  }
  // 09 section 4.1, Nav rail Behavior column: "collapsed by default under
  // 1024px viewport". Read as the INITIAL default only, applied once at
  // mount when no persisted user choice exists yet -- not a continuous,
  // resize-reactive hard constraint that overrides a persisted choice above
  // that width. The alternate reading (viewport width always wins, even
  // over a stored preference) is plausible too; flagged as an open
  // decision in the m2-01 report rather than silently picked.
  return window.matchMedia("(min-width: 1024px)").matches;
}

interface NavRailProps {
  activeZone: Zone;
}

/**
 * The nav rail (09 section 4.1: left edge, fixed, 56px collapsed / 220px
 * expanded). This is the `<nav>` that carries data-testid="platform-nav"
 * (05-a section 7: "The nav element carries data-testid=platform-nav",
 * singular). Topbar renders a `<header>`, not a second `<nav>`, so there is
 * exactly one element in Chrome the test id can unambiguously mean.
 */
function NavRail({ activeZone }: NavRailProps) {
  const [expanded, setExpanded] = React.useState(readInitialExpanded);

  function toggle() {
    setExpanded((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(EXPANDED_STORAGE_KEY, String(next));
        } catch {
          // best-effort persistence only
        }
      }
      return next;
    });
  }

  return (
    <nav
      data-testid="platform-nav"
      data-slot="nav-rail"
      aria-label="Zones"
      data-expanded={expanded}
      className={cn(
        "sticky top-0 flex h-dvh shrink-0 flex-col gap-1 border-r border-border bg-surface py-2 transition-[width] duration-base ease-standard",
        expanded ? "w-[220px] items-stretch px-2" : "w-14 items-center px-1.5"
      )}
    >
      <ul className="flex flex-1 flex-col gap-1">
        {ZONE_ENTRIES.map((entry) => {
          const Icon = entry.icon;
          const active = entry.zone === activeZone;
          return (
            <li key={entry.zone}>
              <a
                href={entry.href}
                data-slot="nav-rail-item"
                data-zone={entry.zone}
                aria-current={active ? "page" : undefined}
                title={expanded ? undefined : entry.label}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-text-secondary outline-none transition-colors hover:bg-accent-muted hover:text-text focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-accent-muted aria-[current=page]:text-text",
                  !expanded && "justify-center px-0"
                )}
              >
                <Icon className="size-4 shrink-0" />
                {expanded && <span className="truncate">{entry.label}</span>}
              </a>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        data-slot="nav-rail-toggle"
        onClick={toggle}
        aria-label={expanded ? "Collapse navigation" : "Expand navigation"}
        aria-expanded={expanded}
        className={cn(
          "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-text-secondary outline-none transition-colors hover:bg-accent-muted hover:text-text focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          !expanded && "justify-center px-0"
        )}
      >
        {expanded ? (
          <PanelLeftClose className="size-4 shrink-0" />
        ) : (
          <PanelLeft className="size-4 shrink-0" />
        )}
        {expanded && <span>Collapse</span>}
      </button>
    </nav>
  );
}

export { NavRail };
