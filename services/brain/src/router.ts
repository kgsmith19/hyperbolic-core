/**
 * Deterministic routing rule and fallback selection (07-brain-
 * architecture.md section 7.4): "`task.harness.preferred` if set and its
 * probe passes; otherwise `claude-code`. On two consecutive `transport`
 * failures of the selected harness, requeue against the first fallback
 * whose probe passes; never silently change harness mid-task." This
 * module only decides WHICH adapter; dispatch.ts is the one place that
 * actually calls start()/journals the decision, so "never silently" is
 * dispatch.ts's obligation, not this file's.
 */
import type { HarnessAdapter, HarnessId } from "./adapters/types.ts";
import type { TaskContractV1 } from "./contracts.ts";

export type AdapterRegistry = Partial<Record<HarnessId, HarnessAdapter>>;

export async function selectInitialAdapter(contract: TaskContractV1, adapters: AdapterRegistry): Promise<HarnessAdapter> {
  const preferredId = contract.harness.preferred;
  if (preferredId) {
    const preferred = adapters[preferredId];
    if (preferred && (await preferred.probe()).ok) return preferred;
  }
  const claudeCode = adapters["claude-code"];
  if (!claudeCode) throw new Error("router: no claude-code adapter registered");
  return claudeCode;
}

/** First entry in the contract's own fallback list whose probe passes,
 * excluding the harness already selected (falling back to yourself is not
 * a fallback). Returns null if none is available -- the caller's job to
 * decide what a task with no viable fallback becomes (dispatch.ts: the
 * transport failure stands as the terminal result). */
export async function selectFallbackAdapter(
  contract: TaskContractV1,
  adapters: AdapterRegistry,
  excludeId: HarnessId
): Promise<HarnessAdapter | null> {
  for (const id of contract.harness.fallback) {
    if (id === excludeId) continue;
    const adapter = adapters[id as HarnessId];
    if (!adapter) continue;
    if ((await adapter.probe()).ok) return adapter;
  }
  return null;
}
