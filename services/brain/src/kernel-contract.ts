/**
 * Maps a brain.task.v1 contract (contracts.ts's TaskContractV1) to the ACC
 * kernel's own (unversioned, pre-existing) contract shape
 * (apps/agentic-command-center/backend/kernel/contract.mjs's REQUIRED_FIELDS:
 * goal, constraints, allowedActions, budget, acceptanceCriteria,
 * rollbackPlan). "kernel.contract.v1" (07 gate question 3) names the
 * MAPPED OUTPUT this function produces -- there is no such version tag
 * recognized or required by the kernel itself (confirmed: kernel/
 * contract.mjs validates only the required-field list above, no `version`
 * key), so `_brainMeta.contractVersion` below is traceability metadata the
 * kernel silently ignores, not something it enforces.
 *
 * Load-bearing kernel-side constraint this mapping must satisfy or the
 * kernel refuses the contract before ever spawning a harness
 * (kernel/contract.mjs:64): acceptanceCriteria must be non-empty. A
 * brain.task.v1 contract with an empty `acceptance` array (m4-09's own
 * skeleton planner default) gets exactly one synthesized criterion here --
 * "the worktree still exists" -- a trivial, always-representable bar, NOT
 * real verification (m4-11's job); it exists solely to satisfy the
 * kernel's hard non-empty requirement for a task that specified none of
 * its own.
 */
import path from "node:path";
import type { TaskContractV1 } from "./contracts.ts";

export interface KernelAcceptanceCriterion {
  id: string;
  ears: string;
  verify: { method: "command"; command: string; cwd?: string } | { method: "file_exists"; path: string };
}

export interface KernelContract {
  goal: string;
  constraints: string[];
  allowedActions: {
    readRoots: string[];
    writeRoots: string[];
    bashPatterns: string[];
    networkHosts: string[];
    vaultKeys: string[];
    subagents: string[];
  };
  budget: { wallClockMin: number; toolCalls: number; tokens: number };
  acceptanceCriteria: KernelAcceptanceCriterion[];
  rollbackPlan: string;
  /** m4-17 (07 section 7.9): "run_id -> task_id -> invocation_id
   * propagate into kernel env and back through ledger refs." run.mjs's
   * appendStarted/appendFinalized (kernel/ledger.mjs) store this whole
   * contract verbatim in each ledger entry, so `_brainMeta` riding along
   * inside it is what makes the kernel's own runs.jsonl joinable back to
   * a Brain run/task/invocation without the kernel needing to understand
   * or validate these fields itself (contract.mjs's validateContract only
   * checks the REQUIRED_FIELDS list, never rejects extras). */
  _brainMeta: { contractVersion: "kernel.contract.v1"; taskId: string; runId: string; invocationId: string };
}

const DEFAULT_TOOL_CALLS_BUDGET = 200;

function networkHostsFor(network: TaskContractV1["constraints"]["network"]): string[] {
  switch (network) {
    case "none":
      return [];
    case "provider-only":
      // ADR-05: the Brain only ever talks to Anthropic directly.
      return ["api.anthropic.com"];
    case "open":
      // 07 section 7.7: `network: open` always requires an explicit
      // approval -- gating that is m4-12's job (autonomy/approvals), not
      // this mapping's; passing "*" through faithfully here is correct as
      // long as the caller never reaches this path for an unapproved task.
      return ["*"];
  }
}

/** kernel/verifier.mjs's "command" method only ever checks `exit status ===
 * 0`; brain.task.v1's verify.expect_exit may be any 0..255 value. Wrapping
 * the original command in a `test $? -eq <expect_exit>` tail makes the two
 * semantics agree without changing what the kernel itself has to
 * understand. */
function wrapForExpectedExit(command: string, expectExit: number): string {
  if (expectExit === 0) return command;
  return `( ${command} ); test $? -eq ${expectExit}`;
}

/** verify.cwd is a path relative to the task's worktree root; the doc's own
 * normative example (07 section 7.5) literally shows "worktree" as its
 * example value, which this treats as the worktree root itself (the "."
 * case) rather than a literal subdirectory named "worktree". */
export function resolveVerifyCwd(worktreePath: string, verifyCwd: string): string {
  if (verifyCwd === "worktree" || verifyCwd === ".") return worktreePath;
  return path.isAbsolute(verifyCwd) ? verifyCwd : path.join(worktreePath, verifyCwd);
}

function mapAcceptance(contract: TaskContractV1, worktreePath: string): KernelAcceptanceCriterion[] {
  if (contract.acceptance.length === 0) {
    return [
      {
        id: "AC-worktree-exists",
        ears: "the task's git worktree still exists after the run (no destructive cleanup occurred) -- not real verification, only a placeholder satisfying the kernel's non-empty acceptanceCriteria requirement for a contract that specified none of its own (m4-11 owns real independent verification)",
        verify: { method: "file_exists", path: worktreePath },
      },
    ];
  }
  return contract.acceptance.map((a) => ({
    id: a.id,
    ears: a.statement,
    verify: {
      method: "command",
      command: wrapForExpectedExit(a.verify.command, a.verify.expect_exit),
      cwd: resolveVerifyCwd(worktreePath, a.verify.cwd),
    },
  }));
}

function constraintLines(contract: TaskContractV1): string[] {
  const lines: string[] = [`network: ${contract.constraints.network}`];
  if (contract.constraints.denied_paths.length) {
    lines.push(`never touch these paths: ${contract.constraints.denied_paths.join(", ")}`);
  }
  if (contract.constraints.allowed_paths.length && !contract.constraints.allowed_paths.includes("**")) {
    lines.push(`work only within: ${contract.constraints.allowed_paths.join(", ")}`);
  }
  lines.push(`deliverable: ${contract.deliverable.type} on branch ${contract.deliverable.branch} (never a default branch)`);
  if (contract.deliverable.push) lines.push("push the branch when done");
  if (contract.deliverable.draft_pr) lines.push("open a draft PR when done");
  return lines;
}

export function mapTaskContractToKernelContract(contract: TaskContractV1, worktreePath: string, invocationId: string): KernelContract {
  return {
    goal: contract.prompt.objective,
    constraints: constraintLines(contract),
    allowedActions: {
      readRoots: [worktreePath],
      writeRoots: [worktreePath],
      // No per-task bash-allowlist concept exists yet in brain.task.v1;
      // defaulting every dispatch to unrestricted Bash inside its own
      // isolated worktree (deny-by-path is still enforced by
      // constraints.denied_paths/allowed_paths above and by the kernel's
      // own guardhook) is a deliberate, documented gap, not a silent one.
      bashPatterns: ["*"],
      networkHosts: networkHostsFor(contract.constraints.network),
      vaultKeys: contract.constraints.vault_keys,
      subagents: [],
    },
    budget: {
      wallClockMin: contract.constraints.wall_clock_min,
      toolCalls: DEFAULT_TOOL_CALLS_BUDGET,
      tokens: contract.constraints.token_budget,
    },
    acceptanceCriteria: mapAcceptance(contract, worktreePath),
    rollbackPlan:
      "Task work is isolated to its own git worktree and never pushes to a default branch; discard the worktree without merging to roll back (07 section 7.4).",
    _brainMeta: { contractVersion: "kernel.contract.v1", taskId: contract.task_id, runId: contract.run_id, invocationId },
  };
}
