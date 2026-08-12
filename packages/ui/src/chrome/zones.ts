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
}

export const ZONE_ENTRIES: readonly ZoneEntry[] = [
  { zone: "home", label: "Home", href: "/", icon: Home },
  { zone: "life", label: "LifeOS", href: "/life/", icon: HeartPulse },
  { zone: "acc", label: "ACC", href: "/acc/", icon: Bot },
  { zone: "tools", label: "Tools", href: "/tools/", icon: Wrench },
  { zone: "prompts", label: "Prompts", href: "/prompts/", icon: NotebookText },
  { zone: "ideas", label: "Ideas", href: "/ideas/", icon: Lightbulb },
];
