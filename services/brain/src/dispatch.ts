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
import type { Task, InvocationStatus } from "./types.ts";
import type { TaskContractV1 } from "./contracts.ts";
import type { AdapterInvocation, HarnessAdapter, HarnessSession } from "./adapters/types.ts";
import { selectInitialAdapter, selectFallbackAdapter, type AdapterRegistry } from "./router.ts";
import { classifySession, classifyThrown, extractRawVerdicts, mapSessionToResult, type FailureClass, type Verification } from "./result-mapper.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";
import { isWorktreeCleanOrCommitted, runVerification } from "./verify.ts";

export interface DispatchDeps {
  adapters: AdapterRegistry;
  workspacesRoot: string;
  journal?: RunJournal;
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

      store.updateInvocationStatus(invocationId, invocationStatusFor(session.outcome), new Date().toISOString());
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
      // Real ledger cross-referencing (the kernel's own runs.jsonl entry
      // for this session) is m4-17's job (telemetry mirror, trace joins);
      // this is a stable, greppable pointer in the meantime, not a
      // resolved path.
      ledgerRef: session!.sessionId ? `kernel-session:${session!.sessionId}` : "unknown",
      verification,
    });

    const now = new Date().toISOString();
    store.updateTaskStatus(task.id, result.status, now, { finishedAt: now, resultJson: JSON.stringify(result) });

    await removeWorktree({
      workspacesRoot: deps.workspacesRoot,
      repoUrl: contract.repo.url,
      taskId: task.id,
      force: result.status !== "succeeded",
    });
    rmSync(stagingDir, { recursive: true, force: true });
  };
}
