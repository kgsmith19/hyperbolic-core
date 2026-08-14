/**
 * Maps a HarnessSession (adapters/types.ts) -- specifically the
 * claude-code adapter's raw kernel result -- into brain.result.v1
 * (contracts.ts's ResultContractV1), and classifies a session's outcome
 * into the failure taxonomy 07-brain-architecture.md section 7.4 names:
 * transport (retry, lane discipline, max 2), logic (non-zero verdicts,
 * never auto-retried), timeout, orphaned.
 *
 * Deliberately out of this issue's scope (07 section 7.4's own table,
 * "Cost accounting" row; hardened at m4-17): the kernel's own result
 * carries only a single combined `tokens` count, never split into
 * input/output/cache-read the way brain.result.v1's `cost` object
 * requires. That split needs the harness's raw stream-json usage fields
 * (07: "usage fields from stream-json result... recorded per
 * invocation"), which `kernel/run.mjs`'s own CLI output does not expose --
 * only its in-process handle.events would. Until m4-17 wires that up, the
 * kernel's combined count is folded into `cost.input_tokens` as a coarse
 * placeholder (documented, not silently mislabeled as a real split) and
 * `usd_estimate` stays null.
 */
import type { ResultContractV1 } from "./contracts.ts";
import type { HarnessSession } from "./adapters/types.ts";

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

function statusFor(session: HarnessSession): ResultContractV1["status"] {
  switch (session.outcome) {
    case "accepted":
      return "succeeded";
    case "rejected":
    case "refused":
    case "failed-to-start":
      return "failed";
    case "aborted-by-budget":
      return "timeout";
    case "orphaned":
      return "interrupted";
  }
}

export interface MapResultParams {
  taskId: string;
  branch: string;
  durationS: number;
  transcriptRef: string;
  ledgerRef: string;
}

export function mapSessionToResult(session: HarnessSession, params: MapResultParams): ResultContractV1 {
  const raw = session.raw as { criteria?: KernelCriterion[]; tokens?: number; error?: string; errors?: string[] } | undefined;
  const criteria = Array.isArray(raw?.criteria) ? raw.criteria : [];
  const verdicts = criteria.map((c) => ({ id: c.id, pass: c.status === "pass", exit: exitCodeFor(c), output_tail: (c.detail ?? "").slice(-2000) }));

  return {
    task_id: params.taskId,
    status: statusFor(session),
    verdicts,
    // Commit discovery inside the worktree is not this issue's scope
    // (no git-log parsing added here); left empty rather than guessed.
    commits: [],
    branch: params.branch,
    pr_url: null,
    cost: { input_tokens: raw?.tokens ?? 0, output_tokens: 0, cache_read_tokens: 0, usd_estimate: null },
    duration_s: params.durationS,
    transcript_ref: params.transcriptRef,
    ledger_ref: params.ledgerRef,
  };
}
