import { AccStatusCard } from "../components/acc-status-card";

/**
 * /acc route group (docs/planning/05-a-hyperbolic-core.md section 4):
 * "V1: ACC status card and link-out to the operator-local ACC UI." Ported
 * ACC pages (05-b section 6) land here after absorption -- out of scope for
 * this issue.
 */
function AccPage() {
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
    </div>
  );
}

export default AccPage;
