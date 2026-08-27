import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle, classifyNavigationTarget } from "@hyperbolic/ui";
import { AccStatusCard } from "../components/acc-status-card";
import { HealthSummary } from "../components/health-summary";

// Presentation-only launcher copy for Home. Deliberately NOT reusing
// packages/ui's internal zone-entries table (nav-rail.tsx / command-palette.tsx's
// ZONE_ENTRIES): that table is not part of packages/ui's public export
// surface (src/index.ts exports Zone, not ZONE_ENTRIES), and Home's cards
// want a longer descriptive sentence per zone that the nav's short labels
// don't carry. Hrefs match the 05-a section 4 route map exactly.
//
// LifeOS is a wholly separate production bundle selected by the private-origin
// nginx configuration at the `/life/` boundary. Shell's `app.tsx` <Routes>
// has no `/life` entry. A plain in-Shell <Link>
// only ever calls history.pushState -- it never issues an HTTP request --
// so a client-side router navigation to /life/ can't reach nginx
// at all and falls straight through to Shell's own catch-all NotFoundPage
// (app.tsx's `<Route path="*">`). `reloadDocument` (below) forces a real
// browser navigation for the cross-zone entry, allowing the private origin
// to select LifeOS's document instead of retaining Shell's document.
// `classifyNavigationTarget` derives that boundary from packages/ui's zone
// registry, so Home owns presentation copy only and cannot drift from the
// nav rail, command palette, or login-return policy. Every other card below
// points at a real Shell route and stays a normal SPA `<Link>`.
const LAUNCHERS: { id: string; name: string; href: string; description: string }[] = [
  {
    id: "life",
    name: "LifeOS",
    href: "/life/",
    description: "Entities, intentions, and health tracking.",
  },
  { id: "acc", name: "ACC", href: "/acc", description: "Agentic Command Center status and link-out." },
  { id: "tools", name: "Tools", href: "/tools", description: "Toolbelt registry surfaces." },
  { id: "prompts", name: "Prompts", href: "/prompts", description: "Prompt Organizer." },
  { id: "ideas", name: "Ideas", href: "/ideas", description: "Idea Intake." },
  { id: "settings", name: "Settings", href: "/settings", description: "Theme, session, unit health, version." },
];

function HomePage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text">Home</h2>
        <p className="mt-1 text-sm text-text-secondary">One front door across every hyperbolic-core zone.</p>
      </div>

      <section>
        <h3 className="mb-3 text-xs font-semibold tracking-wide text-text-secondary uppercase">Zones</h3>
        <div data-testid="launcher-grid" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {LAUNCHERS.map((launcher) => (
            <Link
              key={launcher.id}
              to={launcher.href}
              // react-router 8.3's <Link> supports this natively --
              // when set it skips the SPA click handler entirely (no
              // preventDefault, no pushState) and lets the browser perform
              // its normal anchor navigation, so private-origin nginx sees
              // the request and selects the correct production bundle.
              reloadDocument={classifyNavigationTarget(launcher.href) === "document"}
              data-testid="launcher-card"
              data-zone={launcher.id}
              className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Card className="h-full transition-colors hover:bg-accent-muted">
                <CardHeader>
                  <CardTitle>{launcher.name}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-text-secondary">{launcher.description}</CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-xs font-semibold tracking-wide text-text-secondary uppercase">Health summary</h3>
        <HealthSummary />
      </section>

      <section>
        <h3 className="mb-3 text-xs font-semibold tracking-wide text-text-secondary uppercase">ACC</h3>
        <AccStatusCard />
      </section>
    </div>
  );
}

export default HomePage;
