import { Badge, Spinner } from "@hyperbolic/ui";
import { useUnitHealth, type UnitHealthStatus } from "../lib/health";
import type { DeployableUnit } from "../lib/units";

const STATUS_LABEL: Record<UnitHealthStatus, string> = {
  self: "Operational (this session)",
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

/**
 * One health row per deployable unit (docs/planning/05-a-hyperbolic-core.md
 * section 8). Settings renders the full version (health-check reference
 * text included); Home's compact summary renders the same status via
 * useUnitHealth directly rather than this row -- see components/health-summary.tsx.
 */
function UnitHealthRow({ unit }: { unit: DeployableUnit }) {
  const { status, retry } = useUnitHealth(unit);

  return (
    <div
      data-testid="unit-health-row"
      data-unit-id={unit.id}
      data-status={status}
      className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-text">{unit.name}</span>
        <span className="truncate text-xs text-text-secondary">
          {unit.health.kind === "http" && unit.health.url}
          {unit.health.kind === "command" && <code className="font-mono">{unit.health.command}</code>}
          {unit.health.kind === "self" && unit.health.note}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {status === "checking" && <Spinner />}
        <Badge variant={STATUS_BADGE_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
        {unit.health.kind === "http" && status !== "checking" && (
          <button
            type="button"
            data-testid="unit-health-retry"
            onClick={retry}
            className="text-xs font-medium text-accent hover:underline"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

export { UnitHealthRow };
