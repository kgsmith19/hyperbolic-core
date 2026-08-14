/**
 * Builds the scheduler.ts ApprovalGate the daemon actually uses,
 * combining autonomy.ts's pure decision function with the store-backed
 * "already approved, don't re-park" check and the parking side effect
 * itself (approvals.ts).
 */
import type { BrainStore } from "./store.ts";
import type { RunJournal } from "./journal.ts";
import type { ApprovalGate } from "./scheduler.ts";
import type { TaskContractV1 } from "./contracts.ts";
import { determineApproval, DEFAULT_APPROVAL_TTL_MS } from "./autonomy.ts";
import { latestApprovalFor, parkForApproval } from "./approvals.ts";

export interface ApprovalGateConfig {
  /** Empty = unconfigured = no repo restriction (autonomy.ts's own
   * documented default). */
  repoAllowlist: string[];
  perRunCeilingUsd: number;
  ttlMs?: number;
}

export function createApprovalGate(store: BrainStore, journal: RunJournal | undefined, config: ApprovalGateConfig): ApprovalGate {
  return async (task) => {
    // A task that was already approved keeps re-satisfying the exact
    // same always-approve condition forever (e.g. constraints.network
    // never stops being "open" for a given contract) -- without this
    // check it would park again the instant it returned to `pending`.
    const latest = latestApprovalFor(store, task.id);
    if (latest?.status === "approved") return { needsApproval: false };

    const contract = JSON.parse(task.contractJson) as TaskContractV1;
    const cumulativeCostUsd = store.listCostsForRun(task.runId).reduce((sum, cost) => sum + (cost.usdEstimate ?? 0), 0);

    const decision = determineApproval(contract, contract.autonomy, {
      cumulativeCostUsd,
      perRunCeilingUsd: config.perRunCeilingUsd,
      repoAllowlist: config.repoAllowlist,
    });
    if (!decision.needsApproval) return { needsApproval: false };

    parkForApproval(store, journal, task, decision.reason ?? "approval required", new Date().toISOString(), config.ttlMs ?? DEFAULT_APPROVAL_TTL_MS);
    return { needsApproval: true };
  };
}
