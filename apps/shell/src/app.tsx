import { Route, Routes, useLocation } from "react-router";
import { Chrome, type Zone } from "@hyperbolic/ui";
import { useShellSession } from "./lib/session";
import HomePage from "./pages/home";
import AccPage from "./pages/acc";
import ToolsPage from "./pages/tools";
import PromptsPage from "./pages/prompts";
import IdeasPage from "./pages/ideas";
import SettingsPage from "./pages/settings";
import NotFoundPage from "./pages/not-found";

// Path-prefix -> Zone, matching the 05-a section 4 route map for every
// prefix that map actually lists.
const ZONE_BY_PREFIX: readonly { prefix: string; zone: Zone }[] = [
  { prefix: "/acc", zone: "acc" },
  { prefix: "/tools", zone: "tools" },
  { prefix: "/prompts", zone: "prompts" },
  { prefix: "/ideas", zone: "ideas" },
];

/**
 * Open decision, flagged rather than silently guessed: /settings has no row
 * in the 05-a section 4 route map at all, and ChromeProps.activeZone (05-a
 * section 7) is a closed six-value union (home/life/acc/tools/prompts/ideas)
 * with no "settings" member -- so there is no zone Settings can literally
 * "be." Chrome (m2-01) also ships no settings entry point of its own (no
 * gear icon, no session-menu link) to point at one. This resolves it as: (1)
 * activeZone="home" for /settings, since Settings is a platform-level page
 * rather than owned by any single sub-app zone, and Home is the closest
 * "platform" zone that exists; (2) Home's launcher grid carries a real
 * Settings card so the page has a discoverable entry point instead of being
 * reachable only by typing the URL. Confirm or correct this before m2-03 (the
 * login gate) or m2-01's chrome adds a dedicated settings affordance.
 */
function activeZoneForPath(pathname: string): Zone {
  const match = ZONE_BY_PREFIX.find((entry) => pathname.startsWith(entry.prefix));
  return match ? match.zone : "home";
}

function App() {
  const location = useLocation();
  const { session, isStubSession, onSignOut } = useShellSession();
  const activeZone = activeZoneForPath(location.pathname);

  return (
    <Chrome activeZone={activeZone} session={session} onSignOut={onSignOut}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/acc/*" element={<AccPage />} />
        <Route path="/tools/*" element={<ToolsPage />} />
        <Route path="/prompts/*" element={<PromptsPage />} />
        <Route path="/ideas/*" element={<IdeasPage />} />
        <Route
          path="/settings"
          element={<SettingsPage session={session} isStubSession={isStubSession} onSignOut={onSignOut} />}
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Chrome>
  );
}

export default App;
