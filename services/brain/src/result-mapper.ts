/**
 * Maps a HarnessSession (adapters/types.ts) -- specifically the
 * claude-code adapter's raw kernel result -- into brain.result.v1
 * (contracts.ts's ResultContractV1), and classifies a session's outcome
 * into the failure taxonomy 07-brain-architecture.md section 7.4 names:
 * transport (retry, lane discipline, max 2), logic (non-zero verdicts,
 * never auto-retried), timeout, orphaned.
 *
 * Real, tracked limitation (07 section 7.4's own table, "Cost accounting"
 * row): the kernel's own result carries only a single combined `tokens`
 * count, never split into input/output/cache-read the way
 * brain.result.v1's `cost` object requires. That split needs the
 * harness's raw stream-json usage fields (07: "usage fields from
 * stream-json result... recorded per invocation"), which
 * `kernel/run.mjs`'s own CLI output does not expose -- only its
 * in-process handle.events would, and this adapter never statically
 * imports kernel code (ADR-05's isolation boundary). The kernel's
 * combined count is folded into `cost.input_tokens` as a coarse
 * placeholder (documented, not silently mislabeled as a real split);
 * `usd_estimate` is a blended-rate approximation over that same combined
 * count (pricing.ts's own header comment documents the same gap).
 */
import type { ResultContractV1 } from "./contracts.ts";
import type { HarnessSession } from "./adapters/types.ts";
import { estimateUsd } from "./pricing.ts";

export type FailureClass = "none" | "transport" | "logic" | "timeout" | "orphaned";

const TRANSPORT_SIGNAL_RE = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|\b429\b|\b5\d\d\b|overloaded|failed to spawn/i;

/** Classifies a resolved HarnessSession. A REJECTED start()/resume()
 * promise (spawn failure, etc, caught by the caller before a
 * HarnessSession ever exists) is always `transport` -- see
 * classifyThrown() below, kept separate since it has no session to
 * inspect. */
export function classifySession(session: HarnessSession): FailureClass {
  switch (session.outcome) {
    case "accepted":
      return "none";
    case "rejected":
      // Non-zero verdicts: the harness ran and the kernel's own
      // post-run verifier said no. Never auto-retried (07 section 7.4).
      return "logic";
    case "aborted-by-budget":
      return "timeout";
    case "orphaned":
      return "orphaned";
    case "refused": {
      // The contract itself was malformed -- retrying the identical
      // contract against a different harness would refuse identically,
      // so this is treated like a logic failure (never auto-retried),
      // not a transport one.
      return "logic";
    }
    case "failed-to-start": {
      const raw = session.raw as { error?: string } | undefined;
      return TRANSPORT_SIGNAL_RE.test(String(raw?.error ?? "")) ? "transport" : "logic";
    }
  }
}

/** For a start()/resume() call that rejected outright (spawn ENOENT,
 * timeout before any process existed, etc) -- always transport-class:
 * the harness never got a chance to form an opinion at all. */
export function classifyThrown(): FailureClass {
  return "transport";
}

/** The one place `session.raw.tokens` is read out and cast -- shared by
 * this module's own mapSessionToResult and dispatch.ts's per-invocation
 * cost recording (m4-17) so the "kernel reports one combined count"
 * extraction logic exists exactly once. */
export function tokensFromSession(session: HarnessSession): number {
  const raw = session.raw as { tokens?: number } | undefined;
  return raw?.tokens ?? 0;
}

interface KernelCriterion {
  id: string;
  method: string | null;
  status: "pass" | "fail" | "unknown";
  detail: string;
}

function exitCodeFor(criterion: KernelCriterion): number {
  const match = /exit (\d+)/.exec(criterion.detail ?? "");
  if (match) return Number(match[1]);
  return criterion.status === "pass" ? 0 : 1;
}

/** The verdicts an adapter already reported on the session itself (the
 * ACC kernel's own independent post-run verifyAll(), for claude-code).
 * Exported so dispatch.ts can decide whether to trust this (non-empty --
 * an already-independent check ran) or fall back to the Brain's own
 * verify.ts (empty -- nothing verified anything yet, m4-11's BR-2
 * backstop). */
export function extractRawVerdicts(session: HarnessSession): ResultContractV1["verdicts"] {
  const raw = session.raw as { criteria?: KernelCriterion[] } | undefined;
  const criteria = Array.isArray(raw?.criteria) ? raw.criteria : [];
  return criteria.map((c) => ({ id: c.id, pass: c.status === "pass", exit: exitCodeFor(c), output_tail: (c.detail ?? "").slice(-2000) }));
}

/** m4-11: the Brain's own, freshly-executed verification (verify.ts),
 * authoritative over whatever the adapter itself reported once the
 * harness has run to some terminal state (07 section 7.5's 3-condition
 * completed definition, conditions 1 and 2). Absent for outcomes where
 * verification either cannot mean anything (`orphaned`: unknown state)
 * or never had anything to verify (`aborted-by-budget`, `failed-to-
 * start`, `refused`: the harness never finished, or never ran) --
 * dispatch.ts's job to decide when to supply this, not this module's. */
export interface Verification {
  verdicts: ResultContractV1["verdicts"];
  worktreeClean: boolean;
}

function statusFor(session: HarnessSession, verification?: Verification): ResultContractV1["status"] {
  if (session.outcome === "orphaned") return "interrupted";
  if (session.outcome === "aborted-by-budget") return "timeout";
  if (verification) {
    const allPass = verification.verdicts.length > 0 && verification.verdicts.every((v) => v.pass);
    return allPass && verification.worktreeClean ? "succeeded" : "failed";
  }
  // No brain-side verification available (refused/failed-to-start, or a
  // caller that hasn't wired m4-11's verification through) -- fall back
  // to the adapter's own reported outcome.
  return session.outcome === "accepted" ? "succeeded" : "failed";
}

export interface MapResultParams {
  taskId: string;
  branch: string;
  durationS: number;
  transcriptRef: string;
  ledgerRef: string;
  verification?: Verification;
}

export function mapSessionToResult(session: HarnessSession, params: MapResultParams): ResultContractV1 {
  const verdicts = params.verification ? params.verification.verdicts : extractRawVerdicts(session);
  const tokens = tokensFromSession(session);

  return {
    task_id: params.taskId,
    status: statusFor(session, params.verification),
    verdicts,
    // Commit discovery inside the worktree is not this issue's scope
    // (no git-log parsing added here); left empty rather than guessed.
    commits: [],
    branch: params.branch,
    pr_url: null,
    cost: { input_tokens: tokens, output_tokens: 0, cache_read_tokens: 0, usd_estimate: estimateUsd(tokens, 0, 0) },
    duration_s: params.durationS,
    transcript_ref: params.transcriptRef,
    ledger_ref: params.ledgerRef,
  };
}
