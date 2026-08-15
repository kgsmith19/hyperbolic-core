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
//
// `hardNavigate` marks entries that are NOT Shell routes at all: LifeOS is a
// wholly separate zone stitched in at the infrastructure level by
// `tailscale serve`'s path-based reverse proxy (docs/ops/tailscale-serve-apply.sh's
// ROUTES array maps `/life/` to LifeOS's own, entirely different static
// bundle -- Shell's `app.tsx` <Routes> has no `/life` entry and never will,
// same for active-zone.ts's ZONE_BY_PREFIX table). A plain in-Shell <Link>
// only ever calls history.pushState -- it never issues an HTTP request --
// so a client-side router navigation to /life/ can't reach that proxy layer
// at all and falls straight through to Shell's own catch-all NotFoundPage
// (app.tsx's `<Route path="*">`). `reloadDocument` (below) forces a real
// browser navigation for exactly this one entry, which is the only way to
// actually leave Shell's SPA and let `tailscale serve` route the request.
// Every other card below points at a real Shell route, so it stays a normal
// SPA `<Link>` on purpose -- flip this on ONLY for a zone that is genuinely
// served from outside Shell's own bundle, not for internal Shell pages.
const LAUNCHERS: { id: string; name: string; href: string; description: string; hardNavigate?: boolean }[] = [
  {
    id: "life",
    name: "LifeOS",
    href: "/life/",
    description: "Entities, intentions, and health tracking.",
    hardNavigate: true,
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
              // See the LAUNCHERS comment above: only set true for a zone
              // that lives outside Shell's own SPA bundle (currently just
              // LifeOS). react-router 8.3's <Link> supports this natively --
              // when set it skips the SPA click handler entirely (no
              // preventDefault, no pushState) and lets the browser perform
              // its normal anchor navigation, so path-based reverse proxies
              // (tailscale serve) actually see the request.
              reloadDocument={launcher.hardNavigate}
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
