/**
 * Eval-only scripted harness adapter (m6-01, 07-brain-architecture.md
 * section 7.11). PR-gate CI has zero production secrets
 * (10-cicd-deployment.md section 6), so the seed corpus cannot
 * re-dispatch through a real ClaudeCodeAdapter and pass deterministically
 * -- a genuinely accepted session needs a live Anthropic credential. This
 * adapter scripts only the HARNESS-LEVEL outcome (accepted / rejected /
 * aborted-by-budget / failed-to-start / ...); it never sets
 * `raw.criteria`, so dispatch.ts's own extractRawVerdicts() always falls
 * through to running the case's REAL acceptance[].verify command against
 * the real worktree (verify.ts) -- acceptance checking itself stays
 * unmocked, only the "did the harness run" step is scripted.
 *
 * Wired ONLY into bin/brain.mjs's evalAdapters() (the `brain eval
 * run`/`eval capture` CLI path). The real production daemon's own adapter
 * wiring (src/index.ts) never imports this file, so `brain run` always
 * dispatches to the real adapters regardless of this module's existence.
 *
 * adapters/types.ts's HarnessId is frozen in V1 ("claude-code" | "codex" |
 * "gemini"); this module supplies alternate HarnessAdapter *objects*
 * under those three existing ids, never a fourth id.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AdapterInvocation, HarnessAdapter, HarnessId, HarnessSession, ProbeResult } from "./types.ts";
import type { TaskContractV1 } from "../contracts.ts";

type FixtureOutcome = HarnessSession["outcome"];

const VALID_OUTCOMES: ReadonlySet<string> = new Set<FixtureOutcome>([
  "accepted",
  "rejected",
  "aborted-by-budget",
  "failed-to-start",
  "refused",
  "orphaned",
]);

const MARKER_RE = /\[\[fixture:([a-z-]+)\]\]/;

/** Reads the case contract's own `title` for a `[[fixture:<outcome>]]`
 * marker -- evals.ts's runEvalCase preserves `title` unchanged through
 * its run_id/task_id rewrite, so it is the one contract field a case
 * file's author controls that survives to inv.contractPath verbatim.
 * Defaults to "accepted" (the harness "worked") when no marker is
 * present, so an unmarked case still exercises real verification
 * meaningfully instead of failing for an unrelated reason. */
function outcomeFromTitle(contractPath: string): FixtureOutcome {
  const contract = JSON.parse(readFileSync(contractPath, "utf8")) as TaskContractV1;
  const candidate = contract.title.match(MARKER_RE)?.[1];
  return candidate && VALID_OUTCOMES.has(candidate) ? (candidate as FixtureOutcome) : "accepted";
}

export interface ScriptedFixtureAdapterConfig {
  /** When set, every start()/resume() call returns this outcome
   * regardless of the contract's own title marker -- used for the
   * codex/gemini fixture instances below, whose behavior is fixed by
   * which slot they occupy (transport-retry's preferred/fallback
   * mechanics), not by anything a case's title says. */
  fixedOutcome?: FixtureOutcome;
  tokens?: number;
}

export class ScriptedFixtureAdapter implements HarnessAdapter {
  readonly id: HarnessId;
  #fixedOutcome: FixtureOutcome | undefined;
  #tokens: number;

  constructor(id: HarnessId, config: ScriptedFixtureAdapterConfig = {}) {
    this.id = id;
    this.#fixedOutcome = config.fixedOutcome;
    this.#tokens = config.tokens ?? 100;
  }

  async probe(): Promise<ProbeResult> {
    // Always available: a case that names this adapter as
    // harness.preferred (or lists it in fallback) must actually be
    // routed to it -- router.ts's selectInitialAdapter/
    // selectFallbackAdapter both fall through past a failing probe(),
    // which would silently substitute a different adapter than the case
    // intends to exercise.
    return { ok: true, version: "fixture-1.0.0" };
  }

  async start(inv: AdapterInvocation): Promise<HarnessSession> {
    const outcome = this.#fixedOutcome ?? outcomeFromTitle(inv.contractPath);
    return this.#session(outcome);
  }

  /** No seed case exercises resume() yet; scripted the same as start()
   * rather than throwing, so a future case that does can just work. */
  async resume(_sessionId: string, inv: AdapterInvocation): Promise<HarnessSession> {
    return this.start(inv);
  }

  async cancel(): Promise<void> {
    // Nothing real was ever started; cancelling a scripted session is a no-op.
  }

  #session(outcome: FixtureOutcome): HarnessSession {
    const sessionId = randomUUID();
    if (outcome === "failed-to-start") {
      // result-mapper.ts's TRANSPORT_SIGNAL_RE matches "failed to spawn",
      // which is what makes classifySession() return "transport" here --
      // the transport-retry case's codex slot needs exactly this.
      return { sessionId, outcome, raw: { error: "fixture: failed to spawn (scripted transport failure)" } };
    }
    // Deliberately no `criteria` field: dispatch.ts's extractRawVerdicts()
    // treats a missing/empty array as "the adapter reported nothing" and
    // falls through to running the case's REAL acceptance[].verify
    // command against the real worktree -- verification stays unmocked.
    return { sessionId, outcome, raw: { tokens: this.#tokens } };
  }
}

/** Constructs the three fixture adapter instances `brain eval run` wires
 * in place of the real ClaudeCodeAdapter/codex/gemini adapters
 * (bin/brain.mjs's evalAdapters() is the only call site -- never the real
 * production daemon's own wiring). "claude-code" reads each case's own
 * title marker, the general-purpose slot most cases use; "codex" and
 * "gemini" are fixed to the two outcomes the transport-retry case needs
 * from its preferred/fallback pair. */
export function createEvalFixtureAdapters(): Record<HarnessId, HarnessAdapter> {
  return {
    "claude-code": new ScriptedFixtureAdapter("claude-code"),
    codex: new ScriptedFixtureAdapter("codex", { fixedOutcome: "failed-to-start", tokens: 0 }),
    gemini: new ScriptedFixtureAdapter("gemini", { fixedOutcome: "accepted", tokens: 200 }),
  };
}
