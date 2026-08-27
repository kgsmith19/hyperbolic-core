// The six-zone route map (docs/planning/05-a-hyperbolic-core.md section 4).
//
// Single source of truth for the nav rail (09 section 4.1) and the command
// palette's static navigation entries (09 section 4.2), so the two lists
// can never drift from each other -- the same kind of drift ADR-02's
// reversal trigger exists to catch across zones, applied one level down,
// inside one zone's own chrome.
//
// Labels are the short, zone-consistent names used in both the rail and
// the palette (not the longer "Content" descriptions from 05-a section 4's
// route table, e.g. "Prompt Organizer" / "Idea Intake" -- those name the
// page content the zone serves, not the zone switcher entry itself).
//
// "tool entries from the Toolbelt registry (TB-2)" (09 section 4.1, Nav
// rail Behavior column) is read here as describing the /tools/* PAGE
// content (05-a section 4) and the command palette's future
// registry-sourced entries (09 section 4.2, "registry-enumerated tools"),
// NOT additional nav-rail entries -- the rail stays a fixed six-item list.
// m3-04 supplies the registry; see command-palette.tsx's extension-point
// comment for exactly where that plugs in.

import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { Home, HeartPulse, Bot, Wrench, NotebookText, Lightbulb } from "lucide-react";

export type Zone = "home" | "life" | "acc" | "tools" | "prompts" | "ideas";

export interface ZoneEntry {
  zone: Zone;
  label: string;
  href: string;
  icon: ComponentType<LucideProps>;
  /**
   * Finding #70 (PR #8 security review): marks entries that are NOT part of
   * this SPA's own router at all -- currently just `life`, LifeOS being a
   * wholly separate zone stitched in at the infrastructure level (see
   * `classifyNavigationTarget`, which lets Shell consumers derive the same
   * boundary from this registry instead of maintaining another flag).
   * Every other zone entry is a genuine Shell route and is left `undefined`
   * (falsy) here on purpose, so it is eligible for
   * client-side navigation whenever a consumer wires a `navigate` adapter
   * (nav-rail.tsx / command-palette.tsx / chrome.tsx's `ChromeProps`).
   */
  hardNavigate?: boolean;
}

export const ZONE_ENTRIES: readonly ZoneEntry[] = [
  { zone: "home", label: "Home", href: "/", icon: Home },
  { zone: "life", label: "LifeOS", href: "/life/", icon: HeartPulse, hardNavigate: true },
  { zone: "acc", label: "ACC", href: "/acc/", icon: Bot },
  { zone: "tools", label: "Tools", href: "/tools/", icon: Wrench },
  { zone: "prompts", label: "Prompts", href: "/prompts/", icon: NotebookText },
  { zone: "ideas", label: "Ideas", href: "/ideas/", icon: Lightbulb },
];

export type NavigationTargetKind = "client" | "document";

/**
 * Classifies a same-origin path for a router-owning consumer. Cross-zone
 * roots come from ZONE_ENTRIES rather than a second list, and match only at
 * a path-segment boundary: `/life` and `/life/...` leave the current SPA,
 * while `/lifefoo` does not. Query and fragment suffixes do not affect the
 * decision and remain untouched for the caller to pass to its navigator.
 *
 * This is navigation policy, not URL validation. Callers handling
 * attacker-influenced values must validate them before classification.
 */
export function classifyNavigationTarget(target: string): NavigationTargetKind {
  const pathname = target.split(/[?#]/, 1)[0];
  const isDocumentTarget = ZONE_ENTRIES.some((entry) => {
    if (!entry.hardNavigate) return false;
    const zoneRoot = entry.href.endsWith("/") ? entry.href.slice(0, -1) : entry.href;
    return pathname === zoneRoot || pathname.startsWith(`${zoneRoot}/`);
  });

  return isDocumentTarget ? "document" : "client";
}

/** A function that performs a client-side (SPA) navigation to `href`. */
export type NavigateAdapter = (href: string) => void;

/**
 * Finding #70's central decision, extracted once so nav-rail.tsx and
 * command-palette.tsx -- the two places that render a ZONE_ENTRIES item as
 * a clickable link -- share exactly one rule instead of each hand-rolling
 * their own copy of it.
 *
 * True only when a `navigate` adapter was actually supplied (packages/ui
 * has no router of its own -- see chrome.tsx's own doc comment -- so this
 * is opt-in, wired by whichever app mounts Chrome) AND the entry is not
 * flagged `hardNavigate`. False falls through to the anchor's native
 * `href` navigation: exactly today's behavior for every existing caller
 * that doesn't wire a navigator, and permanently for `hardNavigate`
 * entries regardless of what's wired -- `life` must always leave this
 * SPA's own router entirely, never a client-side transition.
 */
export function shouldNavigateClientSide(
  entry: Pick<ZoneEntry, "hardNavigate">,
  navigate: NavigateAdapter | undefined
): navigate is NavigateAdapter {
  return typeof navigate === "function" && !entry.hardNavigate;
}
