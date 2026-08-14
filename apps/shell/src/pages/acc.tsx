import { Link, Route, Routes } from "react-router";
import { AccStatusCard } from "../components/acc-status-card";
import BrainPage from "./acc/brain";
import CostDashboardPage from "./acc/cost";

/**
 * /acc route group (docs/planning/05-a-hyperbolic-core.md section 4):
 * "V1: ACC status card and link-out to the operator-local ACC UI." Ported
 * ACC pages (05-b section 6) land here after absorption -- out of scope for
 * this issue. Mounted at "/acc/*" (app.tsx), so this component owns its own
 * nested routing (mirrors src/pages/ideas.tsx): the index route is the
 * original status card, "brain" is the m4-16 run/chat surface, "cost" is the
 * m6-02 cost dashboard. Nesting the dashboard here (rather than as a new
 * top-level zone) keeps the Shell's six static zones (src/pages/home.tsx's
 * LAUNCHERS, e2e/tools.spec.ts's own "six static zones" palette assertion)
 * unchanged.
 */
function AccIndexPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-xl font-semibold text-text">ACC</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Agentic Command Center runs as an operator-machine loopback service. V1 renders a status
          card here and links out to its full UI; ported pages land here after absorption
          (docs/planning/05-b-acc.md section 6).
        </p>
      </div>
      <AccStatusCard />
      <Link to="/acc/brain" className="text-sm font-medium text-accent underline" data-testid="brain-run-link">
        Open the Brain run surface
      </Link>
      <Link to="/acc/cost" className="text-sm font-medium text-accent underline" data-testid="cost-dashboard-link">
        Open the cost dashboard
      </Link>
    </div>
  );
}

function AccPage() {
  return (
    <Routes>
      <Route index element={<AccIndexPage />} />
      <Route path="brain" element={<BrainPage />} />
      <Route path="cost" element={<CostDashboardPage />} />
    </Routes>
  );
}

export default AccPage;
