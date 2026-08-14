/**
 * SQLite (WAL) state store (07-brain-architecture.md section 7.6): "Boring,
 * zero new services, mirrors the netcheck precedent." Uses Node's built-in
 * node:sqlite (experimental as of Node 22, but present with no new
 * dependency -- the same "boring" bias section 7.6 itself states) rather
 * than adding better-sqlite3 or any other third-party driver.
 *
 * Crash recovery discipline (section 7.3): "state transitions are
 * journaled before side effects." In this module that means every status
 * transition is a committed SQLite write (WAL fsync) BEFORE the caller
 * performs the corresponding side effect (spawning a harness, etc) --
 * enforced by call order in daemon.ts/scheduler.ts, not by anything this
 * file can check statically. This file's own job is only to make each
 * transition a single durable statement.
 */
import { DatabaseSync } from "node:sqlite";
import type {
  Approval,
  ApprovalStatus,
  Cost,
  EvalCase,
  EvalResult,
  Invocation,
  InvocationStatus,
  Run,
  RunStatus,
  Task,
  TaskEdge,
  TaskEdgeKind,
  TaskStatus,
} from "./types.ts";

const SCHEMA = `
create table if not exists run (
  id text primary key,
  objective text not null,
  autonomy integer not null,
  status text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists task (
  id text primary key,
  run_id text not null references run(id),
  title text not null,
  status text not null,
  contract_json text not null,
  result_json text,
  created_at text not null,
  updated_at text not null,
  started_at text,
  finished_at text
);
create index if not exists task_run_idx on task (run_id);
create index if not exists task_status_idx on task (status);

create table if not exists task_edge (
  parent_task_id text not null references task(id),
  child_task_id text not null references task(id),
  kind text not null,
  primary key (parent_task_id, child_task_id)
);
create index if not exists task_edge_child_idx on task_edge (child_task_id);

create table if not exists invocation (
  id text primary key,
  task_id text not null references task(id),
  harness text not null,
  session_id text,
  status text not null,
  started_at text not null,
  finished_at text
);
create index if not exists invocation_task_idx on invocation (task_id);

create table if not exists approval (
  id text primary key,
  task_id text not null references task(id),
  reason text not null,
  status text not null,
  requested_at text not null,
  resolved_at text,
  expires_at text not null
);
create index if not exists approval_task_idx on approval (task_id);

create table if not exists cost (
  id text primary key,
  task_id text not null references task(id),
  invocation_id text not null references invocation(id),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  usd_estimate real,
  recorded_at text not null
);
create index if not exists cost_task_idx on cost (task_id);
create index if not exists cost_invocation_idx on cost (invocation_id);

create table if not exists eval_case (
  id text primary key,
  name text not null,
  spec_json text not null,
  created_at text not null
);

create table if not exists eval_result (
  id text primary key,
  eval_case_id text not null references eval_case(id),
  run_id text references run(id),
  passed integer not null,
  output_json text not null,
  recorded_at text not null
);
create index if not exists eval_result_case_idx on eval_result (eval_case_id);
`;

export class BrainStore {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec("pragma journal_mode = WAL;");
    this.#db.exec("pragma foreign_keys = ON;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  // --- run ------------------------------------------------------------

  insertRun(run: Run): void {
    this.#db
      .prepare(
        `insert into run (id, objective, autonomy, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(run.id, run.objective, run.autonomy, run.status, run.createdAt, run.updatedAt);
  }

  updateRunStatus(id: string, status: RunStatus, updatedAt: string): void {
    this.#db.prepare(`update run set status = ?, updated_at = ? where id = ?`).run(status, updatedAt, id);
  }

  getRun(id: string): Run | null {
    const row = this.#db.prepare(`select * from run where id = ?`).get(id);
    return row ? rowToRun(row) : null;
  }

  listRuns(): Run[] {
    return this.#db.prepare(`select * from run order by created_at desc`).all().map(rowToRun);
  }

  // --- task -------------------------------------------------------------

  insertTask(task: Task): void {
    this.#db
      .prepare(
        `insert into task (id, run_id, title, status, contract_json, result_json, created_at, updated_at, started_at, finished_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.runId,
        task.title,
        task.status,
        task.contractJson,
        task.resultJson,
        task.createdAt,
        task.updatedAt,
        task.startedAt,
        task.finishedAt
      );
  }

  /** The single write-path every status transition goes through (crash
   * recovery's "journaled before side effects" discipline depends on the
   * CALLER committing this before acting on it, not on anything in here). */
  updateTaskStatus(id: string, status: TaskStatus, updatedAt: string, extra: { startedAt?: string; finishedAt?: string; resultJson?: string } = {}): void {
    const current = this.getTask(id);
    if (!current) throw new Error(`updateTaskStatus: no task ${id}`);
    this.#db
      .prepare(`update task set status = ?, updated_at = ?, started_at = ?, finished_at = ?, result_json = ? where id = ?`)
      .run(
        status,
        updatedAt,
        extra.startedAt ?? current.startedAt,
        extra.finishedAt ?? current.finishedAt,
        extra.resultJson ?? current.resultJson,
        id
      );
  }

  getTask(id: string): Task | null {
    const row = this.#db.prepare(`select * from task where id = ?`).get(id);
    return row ? rowToTask(row) : null;
  }

  listTasksForRun(runId: string): Task[] {
    return this.#db.prepare(`select * from task where run_id = ? order by created_at asc`).all(runId).map(rowToTask);
  }

  listTasksByStatus(status: TaskStatus): Task[] {
    return this.#db.prepare(`select * from task where status = ?`).all(status).map(rowToTask);
  }

  // --- task_edge ----------------------------------------------------------

  insertTaskEdge(edge: TaskEdge): void {
    this.#db
      .prepare(`insert into task_edge (parent_task_id, child_task_id, kind) values (?, ?, ?)`)
      .run(edge.parentTaskId, edge.childTaskId, edge.kind);
  }

  parentsOf(childTaskId: string): TaskEdge[] {
    return this.#db
      .prepare(`select * from task_edge where child_task_id = ?`)
      .all(childTaskId)
      .map(rowToTaskEdge);
  }

  childrenOf(parentTaskId: string): TaskEdge[] {
    return this.#db
      .prepare(`select * from task_edge where parent_task_id = ?`)
      .all(parentTaskId)
      .map(rowToTaskEdge);
  }

  // --- invocation ---------------------------------------------------------

  insertInvocation(invocation: Invocation): void {
    this.#db
      .prepare(
        `insert into invocation (id, task_id, harness, session_id, status, started_at, finished_at)
         values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(invocation.id, invocation.taskId, invocation.harness, invocation.sessionId, invocation.status, invocation.startedAt, invocation.finishedAt);
  }

  updateInvocationStatus(id: string, status: InvocationStatus, finishedAt: string | null): void {
    this.#db.prepare(`update invocation set status = ?, finished_at = ? where id = ?`).run(status, finishedAt, id);
  }

  listInvocationsForTask(taskId: string): Invocation[] {
    return this.#db.prepare(`select * from invocation where task_id = ? order by started_at asc`).all(taskId).map(rowToInvocation);
  }

  // --- approval -----------------------------------------------------------

  insertApproval(approval: Approval): void {
    this.#db
      .prepare(
        `insert into approval (id, task_id, reason, status, requested_at, resolved_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(approval.id, approval.taskId, approval.reason, approval.status, approval.requestedAt, approval.resolvedAt, approval.expiresAt);
  }

  updateApprovalStatus(id: string, status: ApprovalStatus, resolvedAt: string | null): void {
    this.#db.prepare(`update approval set status = ?, resolved_at = ? where id = ?`).run(status, resolvedAt, id);
  }

  listPendingApprovals(): Approval[] {
    return this.#db.prepare(`select * from approval where status = 'pending' order by requested_at asc`).all().map(rowToApproval);
  }

  /** m4-12: lets the scheduler recognize a task that already has an
   * approved (non-pending) approval on file, so re-checking the same
   * always-approve condition on a later tick doesn't re-park it forever. */
  listApprovalsForTask(taskId: string): Approval[] {
    return this.#db.prepare(`select * from approval where task_id = ? order by requested_at asc`).all(taskId).map(rowToApproval);
  }

  // --- cost -----------------------------------------------------------------

  insertCost(cost: Cost): void {
    this.#db
      .prepare(
        `insert into cost (id, task_id, invocation_id, input_tokens, output_tokens, cache_read_tokens, usd_estimate, recorded_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(cost.id, cost.taskId, cost.invocationId, cost.inputTokens, cost.outputTokens, cost.cacheReadTokens, cost.usdEstimate, cost.recordedAt);
  }

  /** m4-17: cost attributed to one specific harness attempt (not the whole
   * task) -- the finer-grained half of the run_id -> task_id ->
   * invocation_id join key 07 section 7.9 requires. */
  listCostsForInvocation(invocationId: string): Cost[] {
    return this.#db.prepare(`select * from cost where invocation_id = ? order by recorded_at asc`).all(invocationId).map(rowToCost);
  }

  listCostsForRun(runId: string): Cost[] {
    return this.#db
      .prepare(`select cost.* from cost join task on task.id = cost.task_id where task.run_id = ? order by recorded_at asc`)
      .all(runId)
      .map(rowToCost);
  }

  /** m4-13's `brain cost` verb: every cost row, optionally since a given
   * ISO timestamp, across every run (not just one). */
  listCosts(sinceIso?: string): Cost[] {
    if (sinceIso) {
      return this.#db.prepare(`select * from cost where recorded_at >= ? order by recorded_at asc`).all(sinceIso).map(rowToCost);
    }
    return this.#db.prepare(`select * from cost order by recorded_at asc`).all().map(rowToCost);
  }

  // --- eval_case / eval_result ----------------------------------------------

  insertEvalCase(evalCase: EvalCase): void {
    this.#db.prepare(`insert into eval_case (id, name, spec_json, created_at) values (?, ?, ?, ?)`).run(evalCase.id, evalCase.name, evalCase.specJson, evalCase.createdAt);
  }

  /** m4-19's `brain eval run`: every eval_result row has a NOT NULL FK to
   * eval_case(id), but `brain eval run` reads cases straight from
   * evals/cases/*.case.json -- files a corpus can carry without ever
   * having gone through `brain eval capture`'s own insertEvalCase call
   * (a case authored by hand, or checked in from another machine). This
   * is the write path that keeps that FK satisfiable regardless of how
   * the case file got there, idempotent so re-running the corpus never
   * errors on a case it already knows about. */
  upsertEvalCase(evalCase: EvalCase): void {
    this.#db
      .prepare(`insert into eval_case (id, name, spec_json, created_at) values (?, ?, ?, ?) on conflict(id) do nothing`)
      .run(evalCase.id, evalCase.name, evalCase.specJson, evalCase.createdAt);
  }

  insertEvalResult(result: EvalResult): void {
    this.#db
      .prepare(`insert into eval_result (id, eval_case_id, run_id, passed, output_json, recorded_at) values (?, ?, ?, ?, ?, ?)`)
      .run(result.id, result.evalCaseId, result.runId, result.passed ? 1 : 0, result.outputJson, result.recordedAt);
  }

  listEvalResultsForCase(evalCaseId: string): EvalResult[] {
    return this.#db.prepare(`select * from eval_result where eval_case_id = ? order by recorded_at asc`).all(evalCaseId).map(rowToEvalResult);
  }

  /** health = "state store writable" (07 section 7.3): a real write/read
   * round trip against a throwaway row, not just "the file handle is open." */
  healthCheck(): boolean {
    try {
      this.#db.exec(`create table if not exists _health (id integer primary key, ts text)`);
      this.#db.prepare(`insert into _health (ts) values (?)`).run(new Date().toISOString());
      this.#db.exec(`delete from _health where id not in (select max(id) from _health)`);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Row mappers (snake_case columns -> camelCase types)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function rowToRun(r: Row): Run {
  return {
    id: r.id as string,
    objective: r.objective as string,
    autonomy: r.autonomy as number,
    status: r.status as RunStatus,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToTask(r: Row): Task {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    title: r.title as string,
    status: r.status as TaskStatus,
    contractJson: r.contract_json as string,
    resultJson: (r.result_json as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function rowToTaskEdge(r: Row): TaskEdge {
  return { parentTaskId: r.parent_task_id as string, childTaskId: r.child_task_id as string, kind: r.kind as TaskEdgeKind };
}

function rowToInvocation(r: Row): Invocation {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    harness: r.harness as string,
    sessionId: (r.session_id as string | null) ?? null,
    status: r.status as InvocationStatus,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function rowToApproval(r: Row): Approval {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    reason: r.reason as string,
    status: r.status as ApprovalStatus,
    requestedAt: r.requested_at as string,
    resolvedAt: (r.resolved_at as string | null) ?? null,
    expiresAt: r.expires_at as string,
  };
}

function rowToCost(r: Row): Cost {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    invocationId: r.invocation_id as string,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    usdEstimate: (r.usd_estimate as number | null) ?? null,
    recordedAt: r.recorded_at as string,
  };
}

function rowToEvalCase(r: Row): EvalCase {
  return { id: r.id as string, name: r.name as string, specJson: r.spec_json as string, createdAt: r.created_at as string };
}

function rowToEvalResult(r: Row): EvalResult {
  return {
    id: r.id as string,
    evalCaseId: r.eval_case_id as string,
    runId: (r.run_id as string | null) ?? null,
    passed: (r.passed as number) === 1,
    outputJson: r.output_json as string,
    recordedAt: r.recorded_at as string,
  };
}

export { rowToEvalCase };
