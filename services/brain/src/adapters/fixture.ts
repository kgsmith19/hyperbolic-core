/**
 * Deterministic, eval-only harness adapters (m6-01).
 *
 * Why these exist: `brain eval run` re-dispatches every corpus case
 * through the REAL dispatch pipeline (dispatch.ts -> router.ts ->
 * verify.ts -> result-mapper.ts), and the PR gate that runs it has zero
 * production secrets by design (10-cicd-deployment.md section 6). A case
 * that reached a genuine `accepted` outcome through claude-code.ts would
 * need a live Anthropic credential in CI, so the corpus could never
 * contain a passing case at all. These adapters script the HARNESS-LEVEL
 * outcome only -- everything downstream of it (the worktree, the Brain's
 * own acceptance verification, the worktree-clean check, status mapping,
 * cost accounting) runs completely unmocked against the case's own real
 * verify commands.
 *
 * Scope discipline: nothing here is ever reachable from a real `brain
 * run`. src/index.ts (the production daemon wiring) constructs
 * ClaudeCodeAdapter/codexAdapter/geminiAdapter and never imports this
 * file; the only construction site is the eval CLI path in
 * bin/brain.mjs. HarnessId (adapters/types.ts) also stays frozen at
 * exactly claude-code|codex|gemini -- these are alternate adapter OBJECTS
 * registered under those existing ids, not a fourth harness.
 */
import { readFileSync } from "node:fs";
import type { AdapterInvocation, HarnessAdapter, HarnessId, HarnessSession, ProbeResult } from "./types.ts";

export type FixtureOutcome = HarnessSession["outcome"];

const VALID_OUTCOMES: ReadonlySet<string> = new Set<FixtureOutcome>([
  "accepted",
  "rejected",
  "aborted-by-budget",
  "failed-to-start",
  "refused",
  "orphaned",
]);

/** A case selects its scripted outcome by embedding this marker in its
 * contract's own `title`. evals.ts's runEvalCase() rewrites task_id and
 * run_id at dispatch time but passes `title` through untouched, so the
 * marker is the one contract field that reliably survives into the
 * contract file this adapter reads back off disk. */
const FIXTURE_MARKER_RE = /\[\[fixture:([a-z-]+)\]\]/;

const DEFAULT_OUTCOME: FixtureOutcome = "accepted";

/** result-mapper.ts's TRANSPORT_SIGNAL_RE matches "failed to spawn", so a
 * `failed-to-start` session carrying this message classifies as
 * `transport` (retryable, then falls back) rather than `logic` (terminal).
 * That distinction is the whole point of the transport-retry case, so the
 * wording here is load-bearing, not cosmetic. */
const TRANSPORT_ERROR = "fixture adapter: failed to spawn (scripted transport failure, no real process was ever launched)";

export interface ScriptedFixtureOptions {
  /** Overrides the contract's title marker entirely. Used for the two
   * dedicated registry entries (codex always transport-fails, gemini
   * always succeeds) whose behavior must not depend on which case is
   * being run. */
  fixedOutcome?: FixtureOutcome;
  /** Folded into cost.input_tokens by result-mapper.ts, exactly as the
   * real kernel's own combined `tokens` count is. */
  tokens?: number;
}

function outcomeFromContract(contractPath: string): FixtureOutcome {
  const contract = JSON.parse(readFileSync(contractPath, "utf8")) as { title?: string };
  const match = FIXTURE_MARKER_RE.exec(contract.title ?? "");
  if (!match) return DEFAULT_OUTCOME;
  const marker = match[1]!;
  // A typo'd marker fails loudly rather than silently degrading to the
  // default: a case that meant to script `rejected` and quietly got
  // `accepted` instead would be a corpus that passes for the wrong
  // reason, which is worse than no corpus at all.
  if (!VALID_OUTCOMES.has(marker)) {
    throw new Error(`fixture adapter: unknown outcome marker "[[fixture:${marker}]]" (valid: ${[...VALID_OUTCOMES].join(", ")})`);
  }
  return marker as FixtureOutcome;
}

export class ScriptedFixtureAdapter implements HarnessAdapter {
  readonly id: HarnessId;
  readonly #fixedOutcome?: FixtureOutcome;
  readonly #tokens: number;

  constructor(id: HarnessId, options: ScriptedFixtureOptions = {}) {
    this.id = id;
    this.#fixedOutcome = options.fixedOutcome;
    this.#tokens = options.tokens ?? 100;
  }

  /** Always available. A failing probe would make router.ts's
   * selectInitialAdapter() silently fall through to claude-code, so a
   * case naming `codex` as its preferred harness would never actually be
   * routed there and the transport-retry case would test nothing. */
  async probe(): Promise<ProbeResult> {
    return { ok: true, version: "fixture-1.0.0" };
  }

  async start(inv: AdapterInvocation): Promise<HarnessSession> {
    const outcome = this.#fixedOutcome ?? outcomeFromContract(inv.contractPath);

    // Deliberately no `criteria` key on `raw`: result-mapper.ts's
    // extractRawVerdicts() then returns empty, which is exactly what makes
    // dispatch.ts fall through to the REAL runVerification() (verify.ts)
    // and spawn the case's own acceptance commands against the real
    // worktree. Scripting verdicts here instead would reduce the corpus to
    // a test of its own fixtures.
    const raw: { tokens: number; error?: string } = { tokens: this.#tokens };
    if (outcome === "failed-to-start") raw.error = TRANSPORT_ERROR;

    return { sessionId: `fixture-${this.id}-${inv.invocationId}`, outcome, raw };
  }

  async resume(_sessionId: string, inv: AdapterInvocation): Promise<HarnessSession> {
    // V1 dispatch never resumes (dispatch.ts only ever calls start()), so
    // this exists to satisfy the interface. Scripting it the same way
    // start() is scripted keeps it honest if that ever changes.
    return this.start(inv);
  }

  async cancel(): Promise<void> {
    // No real process was ever spawned.
  }
}

/** The registry `brain eval run` dispatches against. The three ids carry
 * distinct scripted behavior so a case can select what it exercises purely
 * through its own contract's harness.preferred/fallback fields:
 *
 * - claude-code: reads the case's own `[[fixture:...]]` title marker, so
 *   most cases pick their outcome without touching the registry at all.
 * - codex: always a transport-class failure, so a case that prefers it
 *   drives dispatch.ts's real retry (MAX_ATTEMPTS_PER_HARNESS=2) and
 *   fallback path.
 * - gemini: always succeeds, so it is a viable fallback target for the
 *   above.
 */
export function createEvalFixtureAdapters(): Record<HarnessId, HarnessAdapter> {
  return {
    "claude-code": new ScriptedFixtureAdapter("claude-code"),
    codex: new ScriptedFixtureAdapter("codex", { fixedOutcome: "failed-to-start", tokens: 0 }),
    gemini: new ScriptedFixtureAdapter("gemini", { fixedOutcome: "accepted", tokens: 200 }),
  };
}
