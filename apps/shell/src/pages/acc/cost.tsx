// m6-02 (docs/planning/issues/m6-02-feat-shell-cost-dashboard.md): the Shell
// cost dashboard. Two read-only sections, both sourced live through the
// platform session (no new tables, per this issue's own scope note):
//
//   1. Brain run cost -- services/brain's own SQLite store, grouped by run,
//      task, harness, and day (GET /api/brain/cost, services/brain/src/
//      cost-summary.ts). This is the ONLY place per-task/per-harness
//      granularity exists; the platform core mirror never receives it.
//   2. LLM call attribution -- core.llm_call, grouped by caller_app+purpose,
//      plus the raw recent-calls list so a specific run_ref/caller_app pair
//      can be checked exactly as inserted (this issue's own acceptance
//      criterion).
//
// Mounted at /acc/cost (apps/shell/src/pages/acc.tsx), linked from the ACC
// index page -- same nesting precedent as /acc/brain (see acc.tsx's own
// header comment): this keeps the Shell's six static top-level zones
// (src/pages/home.tsx's LAUNCHERS) unchanged.
import { EmptyState, ErrorState, Skeleton } from "@hyperbolic/ui";
import { BarChart3 } from "lucide-react";
import type { CallerPurposeBucket } from "@hyperbolic/platform-client";
import type { CostBucket } from "@hyperbolic/platform-client";
import { useCostDashboard } from "../../lib/use-cost-dashboard";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const INT = new Intl.NumberFormat("en-US");

function CostDashboardSkeleton() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6" data-testid="cost-dashboard-skeleton">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

interface BucketTableProps {
  testId: string;
  keyLabel: string;
  buckets: readonly CostBucket[];
}

/** One of the four Brain-native breakdowns (byRun/byTask/byHarness/byDay) -- same row shape for all four, only the key column's label changes. */
function BucketTable({ testId, keyLabel, buckets }: BucketTableProps) {
  if (buckets.length === 0) {
    return <p className="text-sm text-text-secondary">No cost recorded yet.</p>;
  }
  return (
    <table data-testid={testId} className="w-full text-left text-sm">
      <thead>
        <tr className="text-xs text-text-secondary">
          <th className="py-1 pr-4 font-medium">{keyLabel}</th>
          <th className="py-1 pr-4 font-medium">Calls</th>
          <th className="py-1 pr-4 font-medium">Input</th>
          <th className="py-1 pr-4 font-medium">Output</th>
          <th className="py-1 font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((bucket) => (
          <tr key={bucket.key} data-testid="cost-bucket-row" data-key={bucket.key} className="border-t border-border">
            <td className="py-1.5 pr-4 font-mono text-text">{bucket.key}</td>
            <td className="py-1.5 pr-4 text-text-secondary" data-field="count">
              {INT.format(bucket.count)}
            </td>
            <td className="py-1.5 pr-4 text-text-secondary" data-field="inputTokens">
              {INT.format(bucket.inputTokens)}
            </td>
            <td className="py-1.5 pr-4 text-text-secondary" data-field="outputTokens">
              {INT.format(bucket.outputTokens)}
            </td>
            <td className="py-1.5 font-mono text-text" data-field="usdEstimate">
              {USD.format(bucket.usdEstimate)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CallerPurposeTable({ buckets }: { buckets: readonly CallerPurposeBucket[] }) {
  if (buckets.length === 0) {
    return <p className="text-sm text-text-secondary">No LLM calls recorded yet.</p>;
  }
  return (
    <table data-testid="cost-caller-purpose-table" className="w-full text-left text-sm">
      <thead>
        <tr className="text-xs text-text-secondary">
          <th className="py-1 pr-4 font-medium">Caller app</th>
          <th className="py-1 pr-4 font-medium">Purpose</th>
          <th className="py-1 pr-4 font-medium">Calls</th>
          <th className="py-1 font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((bucket) => (
          <tr
            key={`${bucket.callerApp} ${bucket.purpose}`}
            data-testid="cost-caller-purpose-row"
            data-caller-app={bucket.callerApp}
            data-purpose={bucket.purpose}
            className="border-t border-border"
          >
            <td className="py-1.5 pr-4 text-text">{bucket.callerApp}</td>
            <td className="py-1.5 pr-4 text-text-secondary">{bucket.purpose}</td>
            <td className="py-1.5 pr-4 text-text-secondary" data-field="count">
              {INT.format(bucket.count)}
            </td>
            <td className="py-1.5 font-mono text-text" data-field="usdEstimate">
              {USD.format(bucket.usdEstimate)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Raw core.llm_call rows, newest first -- the surface that proves a specific run_ref/caller_app pair resolves exactly as inserted (this issue's own attribution acceptance criterion), not just an aggregate. */
function RecentCallsTable({ rows }: { rows: readonly { id: string; callerApp: string; purpose: string; runRef: string | null; usdEstimate: number | null }[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary">No LLM calls recorded yet.</p>;
  }
  return (
    <table data-testid="cost-llm-call-table" className="w-full text-left text-sm">
      <thead>
        <tr className="text-xs text-text-secondary">
          <th className="py-1 pr-4 font-medium">Caller app</th>
          <th className="py-1 pr-4 font-medium">Purpose</th>
          <th className="py-1 pr-4 font-medium">Run ref</th>
          <th className="py-1 font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            data-testid="cost-llm-call-row"
            data-call-id={row.id}
            data-caller-app={row.callerApp}
            data-run-ref={row.runRef ?? ""}
            className="border-t border-border"
          >
            <td className="py-1.5 pr-4 text-text">{row.callerApp}</td>
            <td className="py-1.5 pr-4 text-text-secondary">{row.purpose}</td>
            <td className="py-1.5 pr-4 font-mono text-text-secondary" data-field="runRef">
              {row.runRef ?? "—"}
            </td>
            <td className="py-1.5 font-mono text-text" data-field="usdEstimate">
              {USD.format(row.usdEstimate ?? 0)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CostDashboardPage() {
  const { status, brainSummary, llmCalls, callerPurposeBuckets, errorMessage, retry } = useCostDashboard();

  if (status === "error") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState title="Could not load the cost dashboard" message={errorMessage ?? undefined} onRetry={retry} />
      </div>
    );
  }

  if (status === "loading" || brainSummary === null) {
    return <CostDashboardSkeleton />;
  }

  const hasAnyData =
    brainSummary.byRun.length > 0 ||
    brainSummary.byTask.length > 0 ||
    brainSummary.byHarness.length > 0 ||
    brainSummary.byDay.length > 0 ||
    llmCalls.length > 0;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8 p-6" data-testid="cost-dashboard-page">
      <div>
        <h2 className="text-xl font-semibold text-text">Cost dashboard</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Brain run cost (services/brain's own SQLite store) and cross-tool LLM call attribution (core.llm_call).
        </p>
      </div>

      {!hasAnyData && <EmptyState icon={<BarChart3 />} title="No cost recorded yet." />}

      {hasAnyData && (
        <>
          <section className="flex flex-col gap-6">
            <h3 className="text-xs font-semibold tracking-wide text-text-secondary uppercase">Brain run cost</h3>
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium text-text">Per run</h4>
              <BucketTable testId="cost-by-run" keyLabel="Run" buckets={brainSummary.byRun} />
            </div>
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium text-text">Per task</h4>
              <BucketTable testId="cost-by-task" keyLabel="Task" buckets={brainSummary.byTask} />
            </div>
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium text-text">Per harness</h4>
              <BucketTable testId="cost-by-harness" keyLabel="Harness" buckets={brainSummary.byHarness} />
            </div>
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium text-text">Per day</h4>
              <BucketTable testId="cost-by-day" keyLabel="Day" buckets={brainSummary.byDay} />
            </div>
          </section>

          <section className="flex flex-col gap-6">
            <h3 className="text-xs font-semibold tracking-wide text-text-secondary uppercase">
              LLM call attribution
            </h3>
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium text-text">Per caller app &amp; purpose</h4>
              <CallerPurposeTable buckets={callerPurposeBuckets} />
            </div>
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium text-text">Recent calls</h4>
              <RecentCallsTable rows={llmCalls} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default CostDashboardPage;
