// The /acc status card (docs/planning/05-b-acc.md section 5): reads
// GET /api/process/status and degrades to "ACC unreachable" with no error
// toast. There is no toast surface yet at all (m2-05, out of scope per this
// issue's own text), so that half of the acceptance criterion is
// structurally true -- nothing here is capable of raising one. What this
// component still has to get right on its own: the unreachable branch must
// not render as an alarming, floating, or auto-dismissing surface that
// could be mistaken for one. It renders inline, in the page's normal flow,
// with neutral (not danger-red) styling, because "ACC unreachable" from off
// the operator machine is an EXPECTED state (05-b section 5), not an error.
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from "@hyperbolic/ui";
import { ACC_BASE_URL, useAccStatus } from "../lib/acc";

const TIER_LABEL: Record<"green" | "amber" | "red", string> = {
  green: "Spending is fine",
  amber: "Getting expensive",
  red: "Stopped -- weekly limit hit",
};

const TIER_BADGE_VARIANT: Record<"green" | "amber" | "red", "default" | "secondary" | "destructive"> = {
  green: "default",
  amber: "secondary",
  red: "destructive",
};

function AccStatusCard() {
  const { state, retry, ...rest } = useAccStatus();

  return (
    <Card data-testid="acc-status-card" data-state={state}>
      <CardHeader>
        <CardTitle>ACC status</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state === "loading" && (
          <div className="flex items-center gap-2 text-sm text-text-secondary" data-testid="acc-status-loading">
            <Spinner />
            <span>Checking {ACC_BASE_URL}...</span>
          </div>
        )}

        {state === "unreachable" && (
          <div className="flex flex-col gap-2" data-testid="acc-status-unreachable">
            <p className="text-sm font-medium text-text">ACC unreachable</p>
            <p className="text-sm text-text-secondary">
              No response from the operator-machine loopback API at{" "}
              <code className="font-mono">{ACC_BASE_URL}</code>. This is expected unless you are
              browsing from the machine running <code className="font-mono">npm run gui</code> in
              the ACC repo (docs/planning/05-b-acc.md section 5).
            </p>
            <Button type="button" variant="outline" size="sm" onClick={retry} className="self-start">
              Retry
            </Button>
          </div>
        )}

        {state === "ok" && "data" in rest && (
          <div className="flex flex-col gap-2" data-testid="acc-status-ok">
            <div className="flex flex-wrap items-center gap-2">
              {rest.data.tier ? (
                <Badge variant={TIER_BADGE_VARIANT[rest.data.tier.tier]}>
                  {TIER_LABEL[rest.data.tier.tier]}
                </Badge>
              ) : (
                <Badge variant="secondary">No usage data</Badge>
              )}
              {rest.data.stopped && <Badge variant="destructive">Stopped</Badge>}
            </div>
            <p className="text-sm text-text-secondary">{rest.data.weekText}</p>
          </div>
        )}

        <a
          href={ACC_BASE_URL}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-accent hover:underline"
        >
          Open ACC UI ↗
        </a>
      </CardContent>
    </Card>
  );
}

export { AccStatusCard };
