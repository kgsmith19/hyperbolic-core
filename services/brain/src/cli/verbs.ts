/**
 * The verb-logic layer behind every `brain` CLI command (07-brain-
 * architecture.md section 7.8's CLI table). Pure functions over
 * store/journal/config -- bin/brain.mjs is only argv parsing and calling
 * these, so every exit-code/JSON-shape decision is unit-testable without
 * spawning a subprocess for every scenario. `brain eval` is out of this
 * issue's scope (m4-19); the HTTP API is m4-14's.
 */
import { readFileSync } from "node:fs";
import type { BrainStore } from "../store.ts";
import type { RunJournal } from "../journal.ts";
import type { BrainConfig } from "../config.ts";
import { submitRun, submitContract } from "../run-service.ts";
import type { TaskContractV1 } from "../contracts.ts";
import { determineApproval } from "../autonomy.ts";
import { parkForApproval, resolveApproval, type ApprovalOutcome } from "../approvals.ts";
import { buildContextIndex, writeContextIndex } from "../context-index.ts";
import { SETTABLE_KEYS, isSettableKey, writeOverride } from "../config-overrides.ts";
import { TERMINAL_TASK_STATUSES } from "../types.ts";
import { EXIT_OK, EXIT_ERROR, EXIT_POLICY_REFUSED, EXIT_NOT_FOUND, EXIT_AWAITING_APPROVAL, type VerbResult } from "./result.ts";

const DEFAULT_REPO_URL = "https://github.com/kgsmith19/hyperbolic-core";
const DEFAULT_REPO_REF = "main";

/** Shared with api-routes.ts's POST /runs handler -- same cumulative-cost
 * computation the m4-12 always-approve check needs, exported so the API
 * layer doesn't duplicate it. */
export function cumulativeCostForRun(store: BrainStore, runId: string): number {
  return store.listCostsForRun(runId).reduce((sum, c) => sum + (c.usdEstimate ?? 0), 0);
}

// --- run ---------------------------------------------------------------

export interface RunVerbArgs {
  objective?: string;
  contractPath?: string;
  repoUrl?: string;
  repoRef?: string;
  autonomy?: number;
  harnessPreferred?: "claude-code" | "codex" | "gemini" | null;
  budgetTokens?: number;
  dryRun: boolean;
}

/** BR-1 surface: plans, schema-validates, and journals (submitRun/
 * submitContract, m4-09), same as before. New here (m4-13): a
 * NON-dry-run submission also runs the m4-12 approval decision inline --
 * there is no HTTP API yet (m4-14) for a live daemon to consult, so the
 * CLI makes the same store-only, synchronous decision a live daemon's
 * scheduler would reach on its own next tick, parking the task itself if
 * needed rather than leaving that to chance. */
export function runVerb(store: BrainStore, journal: RunJournal | undefined, config: BrainConfig, args: RunVerbArgs): VerbResult {
  let contract: TaskContractV1 | undefined;
  if (args.contractPath) {
    try {
      contract = JSON.parse(readFileSync(args.contractPath, "utf8")) as TaskContractV1;
    } catch (err) {
      const message = `could not read --contract ${args.contractPath}: ${err instanceof Error ? err.message : String(err)}`;
      return { exitCode: EXIT_ERROR, json: { error: message }, humanText: message };
    }
  } else if (!args.objective) {
    const message = 'usage: brain run "<objective>" [--repo <url>] [--ref <ref>] [--autonomy 0..3] [--harness <id>] [--budget-tokens N] [--dry-run] [--json]';
    return { exitCode: EXIT_POLICY_REFUSED, json: { error: "objective or --contract required" }, humanText: message };
  }

  const result = contract
    ? submitContract(store, contract, journal)
    : submitRun(
        store,
        {
          objective: args.objective!,
          repo: { url: args.repoUrl ?? DEFAULT_REPO_URL, ref: args.repoRef ?? DEFAULT_REPO_REF },
          autonomy: args.autonomy,
          harnessPreferred: args.harnessPreferred,
          tokenBudget: args.budgetTokens,
        },
        journal
      );

  if (!result.ok) {
    const message = `contract failed schema validation:\n${result.errors.join("\n")}`;
    return { exitCode: EXIT_POLICY_REFUSED, json: { errors: result.errors }, humanText: message };
  }

  if (args.dryRun) {
    return { exitCode: EXIT_OK, json: result.contracts, humanText: JSON.stringify(result.contracts, null, 2) };
  }

  const taskContract = result.contracts[0]!;
  const decision = determineApproval(taskContract, taskContract.autonomy, {
    cumulativeCostUsd: cumulativeCostForRun(store, result.run.id),
    perRunCeilingUsd: config.perRunUsdCeiling,
    repoAllowlist: config.repoAllowlist,
  });

  if (decision.needsApproval) {
    const task = store.getTask(taskContract.task_id)!;
    parkForApproval(store, journal, task, decision.reason ?? "approval required", new Date().toISOString(), config.approvalTtlMs);
    const message = `run ${result.run.id} parked awaiting approval: ${decision.reason}`;
    return {
      exitCode: EXIT_AWAITING_APPROVAL,
      json: { run_id: result.run.id, task_id: task.id, status: "awaiting_approval", reason: decision.reason },
      humanText: message,
    };
  }

  const message = `run ${result.run.id} submitted (${result.tasks.length} task(s) pending)`;
  return { exitCode: EXIT_OK, json: { run_id: result.run.id, task_ids: result.tasks.map((t) => t.id) }, humanText: message };
}

// --- status / tasks ------------------------------------------------------

export function statusVerb(store: BrainStore, runId?: string): VerbResult {
  if (!runId) {
    const runs = store.listRuns();
    const humanText = runs.length === 0 ? "no runs" : runs.map((r) => `${r.id}  ${r.status.padEnd(16)}  ${r.objective}`).join("\n");
    return { exitCode: EXIT_OK, json: runs, humanText };
  }
  const run = store.getRun(runId);
  if (!run) {
    const message = `run ${runId} not found`;
    return { exitCode: EXIT_NOT_FOUND, json: { error: message }, humanText: message };
  }
  const tasks = store.listTasksForRun(runId);
  const humanText = [
    `run ${run.id}: ${run.status} (autonomy ${run.autonomy})`,
    run.objective,
    "",
    ...tasks.map((t) => `  ${t.id}  ${t.status.padEnd(16)}  ${t.title}`),
  ].join("\n");
  return { exitCode: EXIT_OK, json: { run, tasks }, humanText };
}

export function tasksVerb(store: BrainStore, runId: string): VerbResult {
  const run = store.getRun(runId);
  if (!run) {
    const message = `run ${runId} not found`;
    return { exitCode: EXIT_NOT_FOUND, json: { error: message }, humanText: message };
  }
  const tasks = store.listTasksForRun(runId).map((t) => {
    let verdicts: unknown[] = [];
    if (t.resultJson) {
      try {
        verdicts = (JSON.parse(t.resultJson) as { verdicts?: unknown[] }).verdicts ?? [];
      } catch {
        verdicts = [];
      }
    }
    return { ...t, verdicts };
  });
  const humanText = tasks.length === 0 ? "no tasks" : tasks.map((t) => `${t.id}  ${t.status.padEnd(16)}  verdicts=${t.verdicts.length}  ${t.title}`).join("\n");
  return { exitCode: EXIT_OK, json: tasks, humanText };
}

// --- approve / reject ------------------------------------------------------

function resolveVerb(store: BrainStore, journal: RunJournal | undefined, taskId: string, outcome: ApprovalOutcome, reason?: string): VerbResult {
  const task = store.getTask(taskId);
  if (!task) {
    const message = `task ${taskId} not found`;
    return { exitCode: EXIT_NOT_FOUND, json: { error: message }, humanText: message };
  }
  const resolved = resolveApproval(store, journal, taskId, outcome, new Date().toISOString());
  if (!resolved) {
    const message = `task ${taskId} has no pending approval`;
    return { exitCode: EXIT_NOT_FOUND, json: { error: message }, humanText: message };
  }
  const updated = store.getTask(taskId)!;
  const message = `task ${taskId} ${outcome}${reason ? ` (${reason})` : ""} -- now ${updated.status}`;
  return { exitCode: EXIT_OK, json: { task_id: taskId, status: updated.status }, humanText: message };
}

export function approveVerb(store: BrainStore, journal: RunJournal | undefined, taskId: string): VerbResult {
  return resolveVerb(store, journal, taskId, "approved");
}

export function rejectVerb(store: BrainStore, journal: RunJournal | undefined, taskId: string, reason?: string): VerbResult {
  return resolveVerb(store, journal, taskId, "rejected", reason);
}

// --- cancel ----------------------------------------------------------------

/** Accepts either a run_id or a task_id (07 section 7.8: `brain cancel
 * <run_id|task_id>`) -- tries task first (the more specific id shape),
 * then run. */
export function cancelVerb(store: BrainStore, journal: RunJournal | undefined, id: string): VerbResult {
  const now = new Date().toISOString();

  const task = store.getTask(id);
  if (task) {
    if (!TERMINAL_TASK_STATUSES.has(task.status)) {
      store.updateTaskStatus(id, "cancelled", now, { finishedAt: now });
      journal?.append({ runId: task.runId, kind: "task.cancelled", taskId: id, reason: "operator cancel" });
    }
    const updated = store.getTask(id)!;
    return { exitCode: EXIT_OK, json: { task_id: id, status: updated.status }, humanText: `task ${id}: ${updated.status}` };
  }

  const run = store.getRun(id);
  if (run) {
    let cancelledCount = 0;
    for (const t of store.listTasksForRun(id)) {
      if (!TERMINAL_TASK_STATUSES.has(t.status)) {
        store.updateTaskStatus(t.id, "cancelled", now, { finishedAt: now });
        journal?.append({ runId: id, kind: "task.cancelled", taskId: t.id, reason: "operator cancel (run-level)" });
        cancelledCount += 1;
      }
    }
    store.updateRunStatus(id, "cancelled", now);
    return { exitCode: EXIT_OK, json: { run_id: id, status: "cancelled", tasks_cancelled: cancelledCount }, humanText: `run ${id}: cancelled (${cancelledCount} task(s))` };
  }

  const message = `${id} is not a known run or task id`;
  return { exitCode: EXIT_NOT_FOUND, json: { error: message }, humanText: message };
}

// --- resume ------------------------------------------------------------

/** "Reconciliation report" (07 section 7.8) for a store-only CLI without
 * a live daemon connection: requeues every `interrupted` task in the run
 * back to `pending` so a live daemon's next scheduler tick (if one is
 * running) picks it up again. daemon.ts's own boot-time reconcile() is
 * the crash-recovery-time version of this same idea; this is the
 * operator-triggered one. */
export function resumeVerb(store: BrainStore, journal: RunJournal | undefined, runId: string): VerbResult {
  const run = store.getRun(runId);
  if (!run) {
    const message = `run ${runId} not found`;
    return { exitCode: EXIT_NOT_FOUND, json: { error: message }, humanText: message };
  }
  const now = new Date().toISOString();
  let requeued = 0;
  for (const task of store.listTasksForRun(runId)) {
    if (task.status === "interrupted") {
      store.updateTaskStatus(task.id, "pending", now);
      journal?.append({ runId, kind: "task.requeued", taskId: task.id, reason: "brain resume" });
      requeued += 1;
    }
  }
  const message = `run ${runId}: requeued ${requeued} interrupted task(s)`;
  return { exitCode: EXIT_OK, json: { run_id: runId, requeued }, humanText: message };
}

// --- logs ------------------------------------------------------------------

export interface LogsResult {
  exitCode: number;
  lines: string[];
}

/** ndjson events, not a VerbResult -- 07's own table lists no `--json`
 * flag for `logs` (stdout is unconditionally "ndjson events"), and
 * --follow is a long-running poll loop that belongs in bin/brain.mjs,
 * not a single pure function call. */
export function logsVerb(store: BrainStore, journal: RunJournal, runId: string, taskFilter?: string): LogsResult {
  const run = store.getRun(runId);
  if (!run) return { exitCode: EXIT_NOT_FOUND, lines: [] };
  const events = journal.read(runId).filter((e) => !taskFilter || e.taskId === taskFilter);
  return { exitCode: EXIT_OK, lines: events.map((e) => JSON.stringify(e)) };
}

// --- cost ------------------------------------------------------------------

export interface CostVerbArgs {
  since?: string;
  runId?: string;
}

export function costVerb(store: BrainStore, args: CostVerbArgs): VerbResult {
  let costs = args.runId ? store.listCostsForRun(args.runId) : store.listCosts(args.since);
  if (args.runId && args.since) costs = costs.filter((c) => c.recordedAt >= args.since!);
  const total = costs.reduce((sum, c) => sum + (c.usdEstimate ?? 0), 0);
  const humanText =
    costs.length === 0
      ? "no cost records"
      : [
          ...costs.map((c) => `${c.recordedAt}  task=${c.taskId}  $${(c.usdEstimate ?? 0).toFixed(4)}  (in=${c.inputTokens} out=${c.outputTokens} cache=${c.cacheReadTokens})`),
          `total: $${total.toFixed(4)}`,
        ].join("\n");
  return { exitCode: EXIT_OK, json: { costs, totalUsd: total }, humanText };
}

// --- refresh-context ---------------------------------------------------

export function refreshContextVerb(config: BrainConfig): VerbResult {
  try {
    const index = buildContextIndex(config.repoRoot, new Date().toISOString());
    writeContextIndex(config.dataDir, index);
    const message = `indexed ${index.entries.length} file(s) from ${config.repoRoot}`;
    return { exitCode: EXIT_OK, json: { entries: index.entries.length, builtAt: index.builtAt, repoRoot: index.repoRoot }, humanText: message };
  } catch (err) {
    const message = `refresh-context failed: ${err instanceof Error ? err.message : String(err)}`;
    return { exitCode: EXIT_ERROR, json: { error: message }, humanText: message };
  }
}

// --- config ------------------------------------------------------------

export interface ConfigVerbArgs {
  action?: "get" | "set";
  key?: string;
  value?: string;
}

/** `config.ts`'s BrainConfig holds no secret VALUES (accVault etc are
 * paths, not the credentials themselves -- ADR-05), so the whole object
 * is safe to print without redaction. */
export function configVerb(config: BrainConfig, args: ConfigVerbArgs): VerbResult {
  const effective = config as unknown as Record<string, unknown>;

  if (!args.action) {
    return { exitCode: EXIT_OK, json: effective, humanText: JSON.stringify(effective, null, 2) };
  }

  if (args.action === "get") {
    if (!args.key || !(args.key in effective)) {
      const message = `unknown config key "${args.key}"`;
      return { exitCode: EXIT_ERROR, json: { error: message }, humanText: message };
    }
    return { exitCode: EXIT_OK, json: { [args.key]: effective[args.key] }, humanText: String(effective[args.key]) };
  }

  // set
  if (!args.key || args.value === undefined) {
    const message = "usage: brain config set <key> <value>";
    return { exitCode: EXIT_ERROR, json: { error: message }, humanText: message };
  }
  if (!isSettableKey(args.key)) {
    const message = `"${args.key}" is not settable (settable keys: ${SETTABLE_KEYS.join(", ")})`;
    return { exitCode: EXIT_POLICY_REFUSED, json: { error: message }, humanText: message };
  }
  writeOverride(config.dataDir, args.key, args.value);
  const message = `${args.key} set to ${args.value} (persisted; effective on next load)`;
  return { exitCode: EXIT_OK, json: { key: args.key, value: args.value }, humanText: message };
}
