// core.llm_call writes (08-llm-handlers.md section 6) via core.log_llm_call
// -- the caller's own bearer token, never the service-role key (see
// config.ts's comment on why /v1/* never touches SUPABASE_SERVICE_ROLE_KEY).
// Same "ride the caller's JWT through PostgREST" posture as postgrest.ts's
// fetchIdeaForSubmit, and the same FR-007 RPC-not-raw-insert convention
// core.log_run's callers already follow.

import type { Provider } from "@hyperbolic/llm";

export interface LlmCallLogEntry {
  callerApp: string;
  purpose: string;
  runRef?: string;
  provider: Provider;
  model: string;
  status: "ok" | "error";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  latencyMs?: number;
  errorClass?: string;
}

/** Best-effort: a telemetry write failing after a real (possibly costly)
 * provider call already succeeded must never mask that success from the
 * caller. Logs to stderr and returns false rather than throwing; the route
 * handlers still return the real LlmResponse/stream to the caller either
 * way. */
export async function logLlmCall(
  supabaseUrl: string,
  supabasePublishableKey: string,
  bearerToken: string,
  entry: LlmCallLogEntry
): Promise<boolean> {
  try {
    const res = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/log_llm_call`, {
      method: "POST",
      headers: {
        apikey: supabasePublishableKey,
        Authorization: `Bearer ${bearerToken}`,
        "Content-Profile": "core",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_caller_app: entry.callerApp,
        p_purpose: entry.purpose,
        p_provider: entry.provider,
        p_model: entry.model,
        p_status: entry.status,
        p_run_ref: entry.runRef ?? null,
        p_input_tokens: entry.inputTokens ?? 0,
        p_output_tokens: entry.outputTokens ?? 0,
        p_cache_read_tokens: entry.cacheReadTokens ?? 0,
        p_latency_ms: entry.latencyMs ?? null,
        p_error_class: entry.errorClass ?? null,
      }),
    });
    if (!res.ok) {
      console.error(`services/llm-handler: core.log_llm_call failed with status ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`services/llm-handler: core.log_llm_call failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
