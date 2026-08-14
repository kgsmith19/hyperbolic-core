// m6-02 (docs/planning/issues/m6-02-feat-shell-cost-dashboard.md): the one
// hook src/pages/acc/cost.tsx renders from. Two independent reads, fired
// together: brainClient.getCostSummary() (services/brain's own SQLite
// store -- the only place per-run/per-task/per-harness/per-day granularity
// exists, see services/brain/src/cost-summary.ts's header comment) and
// costClient.listLlmCalls() (core.llm_call, the cross-tool attribution
// table -- 08-llm-handlers.md section 6). Neither read depends on the
// other, so both are issued in parallel and the page renders once both
// settle; either one failing fails the whole panel (there is no partial
// render -- a half-drawn cost dashboard is worse than a clear error state
// with retry).
import { useCallback, useEffect, useState } from "react";
import type { CostSummary } from "@hyperbolic/platform-client";
import type { CallerPurposeBucket, LlmCallRow } from "@hyperbolic/platform-client";
import { groupLlmCallsByCallerAndPurpose } from "@hyperbolic/platform-client";
import { brainClient, costClient } from "./session";

export interface CostDashboardState {
  status: "loading" | "ready" | "error";
  brainSummary: CostSummary | null;
  llmCalls: LlmCallRow[];
  callerPurposeBuckets: CallerPurposeBucket[];
  errorMessage: string | null;
  retry: () => void;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useCostDashboard(): CostDashboardState {
  const [brainSummary, setBrainSummary] = useState<CostSummary | null>(null);
  const [llmCalls, setLlmCalls] = useState<LlmCallRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setErrorMessage(null);

    Promise.all([brainClient.getCostSummary(), costClient.listLlmCalls()])
      .then(([summary, rows]) => {
        if (cancelled) return;
        setBrainSummary(summary);
        setLlmCalls(rows);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(messageFor(error));
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return {
    status,
    brainSummary,
    llmCalls,
    callerPurposeBuckets: groupLlmCallsByCallerAndPurpose(llmCalls),
    errorMessage,
    retry,
  };
}
