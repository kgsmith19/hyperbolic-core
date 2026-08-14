/**
 * The real DispatchFn (scheduler.ts's injected callback) that m4-08
 * deliberately left a no-op stub for: worktree lifecycle (create before
 * dispatch, remove after result persistence), harness routing with
 * transport-failure fallback (router.ts), a journaled invocation row per
 * actual harness attempt, and the kernel/adapter result mapped into
 * brain.result.v1 before the task's terminal status is written.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrainStore } from "./store.ts";
import type { RunJournal } from "./journal.ts";
import type { BrainLogger } from "./log.ts";
import { TERMINAL_TASK_STATUSES, TERMINAL_SUCCESS_TASK_STATUS, type Task, type InvocationStatus, type RunStatus } from "./types.ts";
import type { TaskContractV1 } from "./contracts.ts";
import type { AdapterInvocation, HarnessAdapter, HarnessSession } from "./adapters/types.ts";
import { selectInitialAdapter, selectFallbackAdapter, type AdapterRegistry } from "./router.ts";
import {
  classifySession,
  classifyThrown,
  extractRawVerdicts,
  mapSessionToResult,
  tokensFromSession,
  type FailureClass,
  type Verification,
} from "./result-mapper.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";
import { isWorktreeCleanOrCommitted, runVerification } from "./verify.ts";
import { estimateUsd } from "./pricing.ts";
import { mirrorRunToCore, type CoreMirrorConfig } from "./core-mirror.ts";

export interface DispatchDeps {
  adapters: AdapterRegistry;
  workspacesRoot: string;
  journal?: RunJournal;
  logger?: BrainLogger;
  /** m4-17 (07 section 7.6): mirrors a run's cost summary to the platform
   * core schema once every task in the run has reached a terminal state.
   * Undefined = mirroring is unconfigured for this deploy; skipped, never
   * an error (core-mirror.ts's own fail-soft posture). */
  coreMirror?: CoreMirrorConfig;
}

/** m4-17: once `task` reaches a terminal status, checks whether every task
 * in its run is now also terminal and, if so, rolls the run itself up to
 * a terminal RunStatus and fires the core mirror -- 07 section 7.6's
 * "run/cost summaries... after run completion." V1's planner only ever
 * emits one task per run (run-service.ts's own skeleton), so this
 * resolves immediately in practice, but it is written against the real
 * task_edge DAG (listTasksForRun / TERMINAL_TASK_STATUSES) so it stays
 * correct once a future planner emits more than one. Never throws: a
 * mirror-write failure must not affect the task's own already-persisted
 * completion (SQLite remains the source of truth, 7.6). */
export async function finalizeRunIfComplete(store: BrainStore, runId: string, deps: Pick<DispatchDeps, "coreMirror" | "logger" | "journal">): Promise<void> {
  const tasks = store.listTasksForRun(runId);
  if (tasks.length === 0 || !tasks.every((t) => TERMINAL_TASK_STATUSES.has(t.status))) return;

  const run = store.getRun(runId);
  if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "interrupted") return;

  const status: RunStatus = tasks.some((t) => t.status === "cancelled")
    ? "cancelled"
    : tasks.some((t) => t.status === "interrupted")
      ? "interrupted"
      : tasks.every((t) => t.status === TERMINAL_SUCCESS_TASK_STATUS)
        ? "completed"
        : "failed";

  const now = new Date().toISOString();
  store.updateRunStatus(runId, status, now);
  deps.journal?.append({ runId, kind: "run.finalized", status });
  deps.logger?.log("info", "run.finalized", { runId }, { status });

  const costs = tasks.flatMap((t) => store.listInvocationsForTask(t.id).flatMap((inv) => store.listCostsForInvocation(inv.id)));
  const wallClockMs = Date.parse(now) - Date.parse(run.createdAt);
  const mirrored = await mirrorRunToCore(deps.coreMirror, run, costs, Math.max(0, wallClockMs));
  deps.logger?.log(mirrored ? "info" : "warn", "run.core_mirror", { runId }, { mirrored });
}

const MAX_ATTEMPTS_PER_HARNESS = 2;

function invocationStatusFor(outcome: HarnessSession["outcome"]): InvocationStatus {
  if (outcome === "accepted") return "completed";
  if (outcome === "orphaned") return "orphaned";
  return "failed";
}

/** Builds the real dispatch callback the Scheduler calls per eligible
 * task. Every failure path here still resolves (never throws): a task
 * that cannot even start a harness ends up with a `failed`/`orphaned`
 * result row, same as one whose harness ran and lost -- scheduler.ts's
 * own #run() catch handler is a backstop for bugs in this function, not a
 * substitute for it handling its own known failure modes. */
export function createDispatchFn(store: BrainStore, deps: DispatchDeps) {
  return async function dispatch(task: Task): Promise<void> {
    const contract = JSON.parse(task.contractJson) as TaskContractV1;
    const startedAtMs = Date.now();

    const worktreePath = await createWorktree({
      workspacesRoot: deps.workspacesRoot,
      repoUrl: contract.repo.url,
      repoRef: contract.repo.ref,
      taskId: task.id,
    });

    const stagingDir = mkdtempSync(path.join(os.tmpdir(), "brain-dispatch-"));
    const contractFile = path.join(stagingDir, "task-contract.json");
    writeFileSync(contractFile, task.contractJson);

    let adapter: HarnessAdapter = await selectInitialAdapter(contract, deps.adapters);
    let session: HarnessSession | undefined;

    // Returns the resulting FailureClass rather than mutating an outer
    // variable: a nested closure reassigning a captured `let` defeats
    // TypeScript's narrowing of that variable at the call site (it cannot
    // see across the closure boundary), which turned real `!==`/`===`
    // comparisons below into false "no overlap" errors when written the
    // mutate-outer-variable way.
    const attempt = async (): Promise<FailureClass> => {
      const invocationId = randomUUID();
      const invStartedAt = new Date().toISOString();
      // journaled before side effect: the invocation row commits before
      // adapter.start() ever runs.
      store.insertInvocation({
        id: invocationId,
        taskId: task.id,
        harness: adapter.id,
        sessionId: null,
        status: "running",
        startedAt: invStartedAt,
        finishedAt: null,
      });

      const inv: AdapterInvocation = {
        invocationId,
        taskId: task.id,
        runId: task.runId,
        contractPath: contractFile,
        worktreePath,
        wallClockMinBudget: contract.constraints.wall_clock_min,
      };

      let outcomeFailClass: FailureClass;
      try {
        session = await adapter.start(inv);
        outcomeFailClass = classifySession(session);
      } catch (err) {
        outcomeFailClass = classifyThrown();
        session = {
          sessionId: invocationId,
          outcome: "orphaned",
          raw: { error: err instanceof Error ? err.message : String(err) },
        };
      }

      const invFinishedAt = new Date().toISOString();
      store.updateInvocationStatus(invocationId, invocationStatusFor(session.outcome), invFinishedAt);

      // m4-17 / BR-5: every invocation gets its own cost row, attributed
      // to this specific attempt (not just the task) -- a retried or
      // harness-fallback task has more than one invocation, and only the
      // invocation id says which attempt actually spent these tokens.
      const tokens = tokensFromSession(session);
      store.insertCost({
        id: randomUUID(),
        taskId: task.id,
        invocationId,
        inputTokens: tokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        usdEstimate: estimateUsd(tokens, 0, 0),
        recordedAt: invFinishedAt,
      });
      deps.logger?.log(
        "info",
        "invocation.cost_recorded",
        { runId: task.runId, taskId: task.id, invocationId },
        { harness: adapter.id, outcome: session.outcome, tokens }
      );

      return outcomeFailClass;
    };

    let attempts = 0;
    let failClass: FailureClass = "none";
    while (attempts < MAX_ATTEMPTS_PER_HARNESS) {
      attempts += 1;
      failClass = await attempt();
      if (failClass !== "transport") break;
    }

    if (failClass === "transport") {
      const fallback = await selectFallbackAdapter(contract, deps.adapters, adapter.id);
      if (fallback) {
        // "never silently change harness mid-task" (07 section 7.4):
        // journaled, not just decided.
        deps.journal?.append({
          runId: task.runId,
          kind: "task.harness_fallback",
          taskId: task.id,
          from: adapter.id,
          to: fallback.id,
          reason: "two consecutive transport failures",
        });
        adapter = fallback;
        await attempt();
      }
    }

    // m4-11 / BR-2: verification is never delegated to the harness that
    // did the work. `orphaned` (unknown final state) and `aborted-by-
    // budget`/`failed-to-start`/`refused` (the harness never finished, or
    // never ran at all) have nothing meaningful to verify -- only a
    // session that reached `accepted`/`rejected` (the kernel's own
    // independent verifyAll() already ran) gets the Brain's own check.
    // MUST run before removeWorktree() below: the worktree-clean check
    // needs the worktree to still exist.
    let verification: Verification | undefined;
    if (session!.outcome === "accepted" || session!.outcome === "rejected") {
      const existing = extractRawVerdicts(session!);
      // Trust the kernel's own already-independent verifyAll() report
      // when it produced one (the normal claude-code path always does,
      // since kernel-contract.ts guarantees >=1 acceptanceCriteria); only
      // fall back to running the commands ourselves when nothing did --
      // BR-2's "never silently dropped" backstop, not routine duplicate
      // work.
      const verdicts = existing.length > 0 ? existing : await runVerification(contract, worktreePath);
      const worktreeClean = await isWorktreeCleanOrCommitted(worktreePath);
      verification = { verdicts, worktreeClean };
    }

    const durationS = (Date.now() - startedAtMs) / 1000;
    const result = mapSessionToResult(session!, {
      taskId: task.id,
      branch: contract.deliverable.branch,
      durationS,
      transcriptRef: `runs/${task.runId}.events.ndjson`,
      // Resolving straight to the kernel's own runs.jsonl entry text is
      // still not done here; m4-17 instead makes that entry FINDABLE by
      // embedding this same invocationId in the contract's own _brainMeta
      // (kernel-contract.ts), which the kernel stores verbatim in its
      // ledger record -- a stable, greppable pointer, not a resolved path.
      ledgerRef: session!.sessionId ? `kernel-session:${session!.sessionId}` : "unknown",
      verification,
    });

    const now = new Date().toISOString();
    store.updateTaskStatus(task.id, result.status, now, { finishedAt: now, resultJson: JSON.stringify(result) });

    // m4-17 / 07 section 7.6: "run/cost summaries... after run
    // completion." Checked after every task's own status write since V1's
    // planner never emits more than one task per run in practice, but the
    // check itself is real (every task in the run terminal), not a
    // single-task shortcut.
    await finalizeRunIfComplete(store, task.runId, deps);

    await removeWorktree({
      workspacesRoot: deps.workspacesRoot,
      repoUrl: contract.repo.url,
      taskId: task.id,
      force: result.status !== "succeeded",
    });
    rmSync(stagingDir, { recursive: true, force: true });
  };
}
