// Pre-call spend-check + call logging against core.broker_call (issue #200,
// buildable slice of #188's budget ledger). Log-only: the check result is
// recorded on the audit log entry, never consulted to refuse anything --
// the same posture services/broker/src/proxy.ts's own hostAllowed signal
// (#187/#199) already established, for the same reason: the actual 429
// enforcement flip is a separate, owner-approved, soak-gated dispatch, not
// a consequence of this code existing.
//
// The broker has no per-request owner JWT -- it authenticates callers by
// its own token scheme (caller-tokens.ts), not a Supabase auth session --
// so every PostgREST call here uses the broker's own service-role key,
// following services/llm-handler/src/postgrest.ts's writeBackSubmitted()
// shape, against core.log_broker_call / core.broker_call_spend_today (both
// service_role-only RPCs, apps/toolbelt/supabase/migrations/
// 20260817170000_core_broker_call.sql).
//
// Never throws (matching proxy.ts's own "never throws" contract, since
// this module's two functions are called from inside proxyRequest): a
// ledger read/write failure degrades to "unknown"/false rather than
// raising, so a Postgres or network hiccup can never turn into a 500 for a
// caller whose actual proxied request has nothing wrong with it.

export interface BudgetConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

/** Dark-until-provisioned (matching credentials.ts/caller-tokens.ts's own
 * convention): returns undefined, never throws, when either env var is
 * absent -- the broker starts fine, and the budget-ledger path in proxy.ts
 * simply never runs until both are provisioned via Infisical
 * /platform/broker/. */
export function loadBudgetConfig(env: NodeJS.ProcessEnv): BudgetConfig | undefined {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return undefined;
  return { supabaseUrl, serviceRoleKey };
}

export interface SpendCheckResult {
  // null means the read failed -- unknown, deliberately never coerced to 0
  // (that would silently under-report real spend back into the log).
  spentTodayUsd: number | null;
  maxUsdPerDay: number | null;
  // Always false when spentTodayUsd is null or maxUsdPerDay is null (no
  // cap): a ledger outage or an uncapped caller must never manufacture a
  // spurious "would deny" signal in the log-only soak data.
  wouldExceedBudget: boolean;
}

function postgrestRpcUrl(supabaseUrl: string, fn: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`;
}

async function callRpc(config: BudgetConfig, fn: string, body: Record<string, unknown>): Promise<Response | null> {
  try {
    return await fetch(postgrestRpcUrl(config.supabaseUrl, fn), {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Profile": "core",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

export async function checkSpend(
  config: BudgetConfig,
  caller: string,
  maxUsdPerDay: number | null,
  estimatedCostUsd: number,
): Promise<SpendCheckResult> {
  const res = await callRpc(config, "broker_call_spend_today", { p_caller: caller });
  if (res === null || !res.ok) {
    return { spentTodayUsd: null, maxUsdPerDay, wouldExceedBudget: false };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { spentTodayUsd: null, maxUsdPerDay, wouldExceedBudget: false };
  }
  const spentTodayUsd = typeof parsed === "number" ? parsed : Number(parsed);
  if (!Number.isFinite(spentTodayUsd)) {
    return { spentTodayUsd: null, maxUsdPerDay, wouldExceedBudget: false };
  }
  const wouldExceedBudget = maxUsdPerDay !== null && spentTodayUsd + estimatedCostUsd > maxUsdPerDay;
  return { spentTodayUsd, maxUsdPerDay, wouldExceedBudget };
}

/** Fire-and-forget from the caller's perspective: never delays or fails the
 * actual proxied response. Returns whether the write succeeded, for tests
 * and diagnostics -- the caller is not required to await or check it. */
export async function logBrokerCall(config: BudgetConfig, caller: string, targetHost: string, costUsd: number): Promise<boolean> {
  const res = await callRpc(config, "log_broker_call", { p_caller: caller, p_target_host: targetHost, p_cost_usd: costUsd });
  return res !== null && res.ok;
}
