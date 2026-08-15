import type { Zone } from "@hyperbolic/ui";

// Path-prefix -> Zone, matching the 05-a section 4 route map for every
// prefix that map actually lists. Lives here (not app.tsx) because
// components/protected-layout.tsx -- not App itself -- is what renders
// Chrome now that the login gate (m2-03) owns the top-level route split.
const ZONE_BY_PREFIX: readonly { prefix: string; zone: Zone }[] = [
  { prefix: "/acc", zone: "acc" },
  { prefix: "/tools", zone: "tools" },
  { prefix: "/prompts", zone: "prompts" },
  { prefix: "/ideas", zone: "ideas" },
];

/**
 * Open decision, flagged rather than silently guessed (carried over from
 * m2-02's app.tsx verbatim): /settings has no row in the 05-a section 4
 * route map at all, and ChromeProps.activeZone (05-a section 7) is a closed
 * six-value union (home/life/acc/tools/prompts/ideas) with no "settings"
 * member -- so there is no zone Settings can literally "be." This resolves
 * it as: activeZone="home" for /settings, since Settings is a
 * platform-level page rather than owned by any single sub-app zone, and
 * Home is the closest "platform" zone that exists.
 */
export function activeZoneForPath(pathname: string): Zone {
  const match = ZONE_BY_PREFIX.find((entry) => pathname.startsWith(entry.prefix));
  return match ? match.zone : "home";
}
