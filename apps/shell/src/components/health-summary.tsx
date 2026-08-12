// Home's "health summary" (this issue's scope text: "Home page: launcher
// cards linking to each zone, a health summary"). Deliberately more compact
// than Settings' full UnitHealthRow list (which also shows each unit's
// documented health-check command/URL) -- Home just needs an at-a-glance
// status per unit; Settings (05-a section 8) owns the detailed table.
import { Badge } from "@hyperbolic/ui";
import { useUnitHealth, type UnitHealthStatus } from "../lib/health";
import { DEPLOYABLE_UNITS } from "../lib/units";

const STATUS_LABEL: Record<UnitHealthStatus, string> = {
  self: "Operational",
  checking: "Checking...",
  ok: "Operational",
  unreachable: "Unreachable",
  manual: "Manual check",
};

const STATUS_BADGE_VARIANT: Record<UnitHealthStatus, "default" | "secondary" | "destructive"> = {
  self: "default",
  checking: "secondary",
  ok: "default",
  unreachable: "destructive",
  manual: "secondary",
};

function HealthSummaryItem({ unit }: { unit: (typeof DEPLOYABLE_UNITS)[number] }) {
  const { status } = useUnitHealth(unit);
  return (
    <div
      data-testid="health-summary-item"
      data-unit-id={unit.id}
      data-status={status}
      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
    >
      <span className="text-sm text-text">{unit.name}</span>
      <Badge variant={STATUS_BADGE_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
    </div>
  );
}

function HealthSummary() {
  return (
    <div data-testid="home-health-summary" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {DEPLOYABLE_UNITS.map((unit) => (
        <HealthSummaryItem key={unit.id} unit={unit} />
      ))}
    </div>
  );
}

export { HealthSummary };
