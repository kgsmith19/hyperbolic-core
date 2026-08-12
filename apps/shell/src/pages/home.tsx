import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@hyperbolic/ui";
import { AccStatusCard } from "../components/acc-status-card";
import { HealthSummary } from "../components/health-summary";

// Presentation-only launcher copy for Home. Deliberately NOT reusing
// packages/ui's internal zone-entries table (nav-rail.tsx / command-palette.tsx's
// ZONE_ENTRIES): that table is not part of packages/ui's public export
// surface (src/index.ts exports Zone, not ZONE_ENTRIES), and Home's cards
// want a longer descriptive sentence per zone that the nav's short labels
// don't carry. Hrefs match the 05-a section 4 route map exactly.
const LAUNCHERS: { id: string; name: string; href: string; description: string }[] = [
  { id: "life", name: "LifeOS", href: "/life/", description: "Entities, intentions, and health tracking." },
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
