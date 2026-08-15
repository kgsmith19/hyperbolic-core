// The platform cost dashboard (m6-02). Mounted at /acc/cost
// (apps/shell/frontend/src/pages/acc.tsx), alongside the Brain run/chat surface
// (m4-16) in the same /acc area since both read Brain-owned telemetry.
//
// Three panels: Brain cost (per run, rolled up per day -- core.cost's own
// primary key is run_id, so lib/cost.ts's own client-side PostgREST
// queries only ever reach that granularity), Brain cost per task/per
// harness (the ONE place that finer granularity exists at all -- the
// Brain's own SQLite store, read live through GET /api/brain/cost since
// the platform core mirror never receives it, see services/brain/src/
// cost-summary.ts's header comment), and core.llm_call grouped by
// caller_app/purpose (08-llm-handlers.md section 6's attribution model).
import type { ReactNode } from "react";
import { BarChart3 } from "lucide-react";
import { EmptyState, ErrorState, Skeleton, useDelayedVisible } from "@hyperbolic/ui";
import type { CostBucket, CostSummary } from "@hyperbolic/platform-client";
import { groupBrainCostByDay, listBrainRunCosts, listLlmCallGroups, type BrainRunCost, type LlmCallGroup } from "../../lib/cost";
import { brainClient } from "../../lib/session";
import { useAsync } from "../../lib/use-async";

interface CostData {
  runs: BrainRunCost[];
  llmCallGroups: LlmCallGroup[];
  brainSummary: CostSummary;
}

async function loadCostData(): Promise<CostData> {
  const [runs, llmCallGroups, brainSummary] = await Promise.all([
    listBrainRunCosts(),
    listLlmCallGroups(),
    brainClient.getCostSummary(),
  ]);
  return { runs, llmCallGroups, brainSummary };
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function CostSkeleton() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6" data-testid="cost-dashboard-skeleton">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h3 className="text-sm font-medium text-text">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function DailyCostTable({ runs }: { runs: BrainRunCost[] }) {
  const daily = groupBrainCostByDay(runs);
  if (daily.length === 0) return <p className="text-sm text-text-secondary">No Brain runs mirrored yet.</p>;
  return (
    <table className="w-full text-left text-sm" data-testid="cost-daily-table">
      <thead>
        <tr className="text-text-secondary">
          <th className="pb-2 font-normal">Day</th>
          <th className="pb-2 font-normal">Runs</th>
          <th className="pb-2 font-normal">Input tokens</th>
          <th className="pb-2 font-normal">Output tokens</th>
          <th className="pb-2 font-normal">USD</th>
        </tr>
      </thead>
      <tbody>
        {daily.map((day) => (
          <tr key={day.date} className="border-t border-border" data-testid="cost-daily-row">
            <td className="py-1.5">{day.date}</td>
            <td className="py-1.5">{day.runs}</td>
            <td className="py-1.5">{day.inputTokens.toLocaleString()}</td>
            <td className="py-1.5">{day.outputTokens.toLocaleString()}</td>
            <td className="py-1.5">{usd(day.usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunCostTable({ runs }: { runs: BrainRunCost[] }) {
  if (runs.length === 0) return <p className="text-sm text-text-secondary">No Brain runs mirrored yet.</p>;
  return (
    <table className="w-full text-left text-sm" data-testid="cost-runs-table">
      <thead>
        <tr className="text-text-secondary">
          <th className="pb-2 font-normal">Run</th>
          <th className="pb-2 font-normal">Started</th>
          <th className="pb-2 font-normal">Status</th>
          <th className="pb-2 font-normal">Tokens</th>
          <th className="pb-2 font-normal">USD</th>
        </tr>
      </thead>
      <tbody>
        {runs.slice(0, 25).map((run) => (
          <tr key={run.runId} className="border-t border-border" data-testid="cost-run-row">
            <td className="py-1.5 font-mono text-xs">{run.runId.slice(0, 8)}</td>
            <td className="py-1.5">{new Date(run.startedAt).toLocaleString()}</td>
            <td className="py-1.5">{run.status}</td>
            <td className="py-1.5">{(run.inputTokens + run.outputTokens).toLocaleString()}</td>
            <td className="py-1.5">{usd(run.usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LlmCallTable({ groups }: { groups: LlmCallGroup[] }) {
  if (groups.length === 0) return <p className="text-sm text-text-secondary">No LLM calls logged in the last 30 days.</p>;
  return (
    <table className="w-full text-left text-sm" data-testid="cost-llmcall-table">
      <thead>
        <tr className="text-text-secondary">
          <th className="pb-2 font-normal">Caller app</th>
          <th className="pb-2 font-normal">Purpose</th>
          <th className="pb-2 font-normal">Calls</th>
          <th className="pb-2 font-normal">Tokens</th>
          <th className="pb-2 font-normal">USD</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr key={`${group.callerApp} ${group.purpose}`} className="border-t border-border" data-testid="cost-llmcall-row">
            <td className="py-1.5">{group.callerApp}</td>
            <td className="py-1.5">{group.purpose}</td>
            <td className="py-1.5">{group.calls}</td>
            <td className="py-1.5">{(group.inputTokens + group.outputTokens).toLocaleString()}</td>
            <td className="py-1.5">{usd(group.usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Brain cost per task / per harness (m6-02): the two breakdowns that
 * exist ONLY in the Brain's own SQLite store (services/brain/src/cost-
 * summary.ts's own header comment) -- same row shape for both, only the
 * key column's label changes. */
function BucketTable({ testId, keyLabel, buckets }: { testId: string; keyLabel: string; buckets: CostBucket[] }) {
  if (buckets.length === 0) return <p className="text-sm text-text-secondary">No cost recorded yet.</p>;
  return (
    <table className="w-full text-left text-sm" data-testid={testId}>
      <thead>
        <tr className="text-text-secondary">
          <th className="pb-2 font-normal">{keyLabel}</th>
          <th className="pb-2 font-normal">Calls</th>
          <th className="pb-2 font-normal">Tokens</th>
          <th className="pb-2 font-normal">USD</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map((bucket) => (
          <tr key={bucket.key} className="border-t border-border" data-testid={`${testId}-row`}>
            <td className="py-1.5 font-mono text-xs">{bucket.key}</td>
            <td className="py-1.5">{bucket.count}</td>
            <td className="py-1.5">{(bucket.inputTokens + bucket.outputTokens).toLocaleString()}</td>
            <td className="py-1.5">{usd(bucket.usdEstimate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CostPage() {
  const { status, data, errorMessage, retry } = useAsync(loadCostData);
  const showSkeleton = useDelayedVisible(status === "loading");

  if (status === "error") {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <ErrorState title="Could not load cost data" message={errorMessage ?? undefined} onRetry={retry} />
      </div>
    );
  }

  if (status === "loading") {
    return showSkeleton ? <CostSkeleton /> : null;
  }

  if (!data) return null;

  const hasBrainSummaryData =
    data.brainSummary.byTask.length > 0 || data.brainSummary.byHarness.length > 0;

  if (data.runs.length === 0 && data.llmCallGroups.length === 0 && !hasBrainSummaryData) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <EmptyState
          icon={<BarChart3 />}
          title="No cost data yet -- runs and LLM calls will appear here once the platform starts logging them."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6" data-testid="cost-dashboard-page">
      <div>
        <h2 className="text-xl font-semibold text-text">Cost dashboard</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Brain cost per run and per day (core.run/core.cost), per task and per harness (the Brain's own SQLite
          store, GET /api/brain/cost), and LLM call attribution per caller app and purpose (core.llm_call, last 30
          days).
        </p>
      </div>

      <Panel title="Brain cost per day">
        <DailyCostTable runs={data.runs} />
      </Panel>

      <Panel title="Brain cost per run">
        <RunCostTable runs={data.runs} />
      </Panel>

      <Panel title="Brain cost per task">
        <BucketTable testId="cost-task-table" keyLabel="Task" buckets={data.brainSummary.byTask} />
      </Panel>

      <Panel title="Brain cost per harness">
        <BucketTable testId="cost-harness-table" keyLabel="Harness" buckets={data.brainSummary.byHarness} />
      </Panel>

      <Panel title="LLM calls by caller app / purpose">
        <LlmCallTable groups={data.llmCallGroups} />
      </Panel>
    </div>
  );
}

export default CostPage;
