/**
 * Telemetry mirror to the platform `core` schema (07-brain-architecture.md
 * section 7.6: "run/cost summaries are also written to the platform
 * project's core schema... via the existing RPC pattern; SQLite remains
 * the source of truth") and section 7.9's "Cost dashboard: UI panel
 * reading the cost table joined to the platform core mirror."
 *
 * Same FR-007 RPC-not-raw-insert convention services/llm-handler/src/
 * llm-call-log.ts already follows for core.llm_call, extended here for
 * core.log_run (20260807080000_core_log_run_rpc.sql) once m4-17's own
 * migration adds the token/usd parameters that RPC's own header comment
 * names as its likely next extension ("no current caller produces
 * them" -- the Brain is the first).
 *
 * Unlike Handler A's write (which rides the calling HTTP request's own
 * bearer token), this fires from the daemon's background dispatch path
 * after a run finishes -- there is no per-request caller identity to
 * ride. It uses the service-role key the same way
 * services/llm-handler/src/postgrest.ts's writeBackSubmitted does for its
 * own system-initiated write, scoped to this one RPC call only.
 *
 * Best-effort like logLlmCall: a mirror-write failure must never affect
 * the run's own already-persisted SQLite state (7.6: "SQLite remains the
 * source of truth"). Logs and returns false rather than throwing.
 */
import type { Cost, Run } from "./types.ts";

export interface CoreMirrorConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

function sumCosts(costs: Cost[]): { inputTokens: number; outputTokens: number; cacheReadTokens: number; usd: number } {
  return costs.reduce(
    (acc, c) => ({
      inputTokens: acc.inputTokens + c.inputTokens,
      outputTokens: acc.outputTokens + c.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + c.cacheReadTokens,
      usd: acc.usd + (c.usdEstimate ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, usd: 0 }
  );
}

/** Mirrors one finished run's summary into core.run/core.cost. `ref` is
 * set to the Brain's own run id (BR-5's join key, and the literal value
 * this issue's own verification command checks: `select count(*) from
 * core.run where ref='<brain-run-id>'`). Returns true only on a
 * successful RPC response. */
export async function mirrorRunToCore(config: CoreMirrorConfig | undefined, run: Run, costs: Cost[], wallClockMs: number): Promise<boolean> {
  if (!config) return false;
  const totals = sumCosts(costs);
  try {
    const res = await fetch(`${config.supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/log_run`, {
      method: "POST",
      headers: {
        apikey: config.supabaseServiceRoleKey,
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        "Content-Profile": "core",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_app_id: "brain",
        p_kind: "run",
        p_wall_clock_ms: wallClockMs,
        p_ref: run.id,
        p_input_tokens: totals.inputTokens,
        p_output_tokens: totals.outputTokens,
        p_cache_read_tokens: totals.cacheReadTokens,
        p_usd: totals.usd,
      }),
    });
    if (!res.ok) {
      console.error(`services/brain: core.log_run mirror failed with status ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`services/brain: core.log_run mirror failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
