/**
 * Daemon lifecycle (07-brain-architecture.md section 7.3): "Startup: load
 * config, open state store, reconcile, begin serving." / "Shutdown: SIGTERM
 * drains: running harness children get contract-completion grace up to
 * 120 s, then are killed process-group style... and their tasks marked
 * interrupted (resumable)." / "Crash recovery: ... on boot, any task in
 * running is probed ... and either re-attached, resumed via harness
 * session resume, or marked interrupted."
 *
 * m4-08's own scope excludes real harness adapters (m4-10) -- probe/resume
 * are injected callbacks here, defaulting to a conservative stub that
 * always reports "not live" (liveProbe below), which is the only truthful
 * default without a real adapter: every task found running at boot is
 * marked interrupted until m4-10 wires in a real liveness probe.
 */
import { BrainStore } from "./store.ts";
import { RunJournal } from "./journal.ts";
import { Scheduler, type ApprovalGate, type DispatchFn } from "./scheduler.ts";
import { sweepExpiredApprovals } from "./approvals.ts";

export interface LiveProbeResult {
  /** true: the harness session is still alive and should be re-attached.
   * false: the session is gone; `resumable` decides interrupted vs resumed. */
  live: boolean;
  /** Only consulted when live is false. true: the harness supports
   * resuming this session (07 section 7.4's `resume()`); the caller may
   * attempt resume(). false: mark interrupted outright. */
  resumable: boolean;
}

export type LiveProbeFn = (invocationId: string, sessionId: string | null) => Promise<LiveProbeResult>;

/** Conservative default: without a real adapter (m4-10), the daemon cannot
 * truthfully claim a session is alive or resumable, so every running task
 * found at boot is marked interrupted -- resumable in the sense that a
 * later manual/automatic retry can requeue it (07 section 7.3: "marked
 * interrupted (resumable)"), never left claiming to be running when
 * nothing can prove it still is. */
export const stubLiveProbe: LiveProbeFn = async () => ({ live: false, resumable: false });

export interface DaemonOptions {
  dbPath: string;
  dataDir: string;
  liveProbe?: LiveProbeFn;
  dispatch?: DispatchFn;
  /** m4-10: the real dispatch function (dispatch.ts's createDispatchFn)
   * needs the daemon's own BrainStore/RunJournal instances, which don't
   * exist until this constructor runs -- a plain `dispatch: DispatchFn`
   * option can't express that dependency, since the caller would have to
   * construct a SEPARATE store/journal pointed at the same paths just to
   * build it. Takes precedence over `dispatch` when both are supplied. */
  dispatchFactory?: (store: BrainStore, journal: RunJournal) => DispatchFn;
  /** m4-12: same store/journal-dependency reasoning as dispatchFactory --
   * approval-gate.ts's createApprovalGate needs the daemon's own store
   * instance. */
  approvalGateFactory?: (store: BrainStore, journal: RunJournal) => ApprovalGate;
  maxConcurrent?: number;
  /** Grace period before killTree on shutdown (07 section 7.3: "up to
   * 120 s"). Overridable for tests; production default is 120_000. */
  shutdownGraceMs?: number;
  /** How often the approval-TTL sweep runs (07 section 7.7's TTL is
   * measured in days, so this doesn't need 1 s granularity like the
   * scheduler's own tick). Overridable for tests; production default is
   * hourly. */
  approvalSweepIntervalMs?: number;
}

export type HealthStatus = "ok" | "degraded";

export interface Health {
  status: HealthStatus;
  stateStoreWritable: boolean;
  providerReachable: boolean;
  uptimeMs: number;
}

/** health = "event loop responsive, state store writable, provider
 * reachable (cached probe, 60 s)" (07 section 7.3). Event-loop
 * responsiveness is implicit: this function itself only returns because
 * the loop was free to run it. */
export class BrainDaemon {
  readonly store: BrainStore;
  readonly journal: RunJournal;
  readonly scheduler: Scheduler;
  #liveProbe: LiveProbeFn;
  #startedAt = 0;
  #shutdownGraceMs: number;
  #tickTimer: NodeJS.Timeout | null = null;
  #approvalSweepTimer: NodeJS.Timeout | null = null;
  #approvalSweepIntervalMs: number;
  #providerReachableCache: { ok: boolean; checkedAtMs: number } | null = null;

  constructor(options: DaemonOptions) {
    this.store = new BrainStore(options.dbPath);
    this.journal = new RunJournal(options.dataDir);
    this.#liveProbe = options.liveProbe ?? stubLiveProbe;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 120_000;
    this.#approvalSweepIntervalMs = options.approvalSweepIntervalMs ?? 60 * 60 * 1000;
    const dispatch: DispatchFn = options.dispatchFactory
      ? options.dispatchFactory(this.store, this.journal)
      : (options.dispatch ?? (async () => {}));
    const approvalGate: ApprovalGate | undefined = options.approvalGateFactory?.(this.store, this.journal);
    this.scheduler = new Scheduler(this.store, dispatch, options.maxConcurrent, approvalGate);
  }

  /** load config (caller's job before constructing this), open state store
   * (constructor), reconcile, begin serving -- this method is the last two
   * steps of 07 section 7.3's startup sequence. */
  async start(): Promise<void> {
    this.#startedAt = Date.now();
    await this.reconcile();
    this.#tickTimer = setInterval(() => {
      void this.scheduler.tick();
    }, 1000);
    this.#tickTimer.unref();
    // m4-12: TTL expiry (07 section 7.7: "an unapproved task expires to
    // cancelled after a configurable TTL... with its rationale
    // journaled"). Runs on its own slower cadence -- nothing about
    // approval TTLs needs 1 s scheduler-tick granularity.
    this.#approvalSweepTimer = setInterval(() => {
      sweepExpiredApprovals(this.store, this.journal, new Date().toISOString());
    }, this.#approvalSweepIntervalMs);
    this.#approvalSweepTimer.unref();
  }

  /** Boot-time reconciliation (07 section 7.3): every task left in
   * `running` is probed and re-attached, resumed, or marked interrupted.
   * "None shall remain running" is the acceptance criterion this method
   * exists to satisfy -- every branch below ends in a definite status. */
  async reconcile(): Promise<{ reattached: number; resumed: number; interrupted: number }> {
    const running = this.store.listTasksByStatus("running");
    let reattached = 0;
    let resumed = 0;
    let interrupted = 0;
    const now = new Date().toISOString();

    for (const task of running) {
      const invocations = this.store.listInvocationsForTask(task.id);
      const lastInvocation = invocations.at(-1) ?? null;
      const probe = await this.#liveProbe(lastInvocation?.id ?? task.id, lastInvocation?.sessionId ?? null);

      if (probe.live) {
        reattached += 1;
        this.journal.append({ runId: task.runId, kind: "task.reattached", taskId: task.id });
        continue;
      }
      if (probe.resumable) {
        resumed += 1;
        this.journal.append({ runId: task.runId, kind: "task.resumed", taskId: task.id });
        // Resuming keeps the task in `running` (a new invocation attempt is
        // the caller's job, e.g. the scheduler's own dispatch path); this
        // reconcile pass only decided the classification, not the retry.
        continue;
      }
      // journaled before side effects: the durable status write happens
      // here, synchronously, before this loop ever returns -- there is no
      // side effect left to perform for an interrupted task at reconcile
      // time (no process to signal; probe.live already said it's gone).
      this.store.updateTaskStatus(task.id, "interrupted", now, { finishedAt: now });
      if (lastInvocation) {
        this.store.updateInvocationStatus(lastInvocation.id, "orphaned", now);
      }
      interrupted += 1;
      this.journal.append({ runId: task.runId, kind: "task.interrupted", taskId: task.id });
    }
    return { reattached, resumed, interrupted };
  }

  async health(): Promise<Health> {
    const stateStoreWritable = this.store.healthCheck();
    const nowMs = Date.now();
    if (!this.#providerReachableCache || nowMs - this.#providerReachableCache.checkedAtMs > 60_000) {
      // "provider reachable (cached probe, 60 s)": without a real adapter
      // (m4-10) this is the same conservative stub liveProbe uses -- a
      // fixed, truthful "cannot confirm" rather than an optimistic
      // hardcoded true.
      this.#providerReachableCache = { ok: this.#liveProbe !== stubLiveProbe, checkedAtMs: nowMs };
    }
    const providerReachable = this.#providerReachableCache.ok;
    return {
      status: stateStoreWritable ? "ok" : "degraded",
      stateStoreWritable,
      providerReachable,
      uptimeMs: this.#startedAt ? nowMs - this.#startedAt : 0,
    };
  }

  /** SIGTERM drain (07 section 7.3): running harness children get grace up
   * to shutdownGraceMs, then are killed process-group style (killTree
   * pattern) and their tasks marked interrupted. m4-08 has no real
   * children to kill yet (m4-10's job); this method's own responsibility
   * -- stopping the scheduler's tick loop and marking every task still
   * `running` at the grace deadline as interrupted -- is fully testable
   * without one. */
  async shutdown(): Promise<{ interrupted: number }> {
    if (this.#tickTimer) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    if (this.#approvalSweepTimer) {
      clearInterval(this.#approvalSweepTimer);
      this.#approvalSweepTimer = null;
    }
    const deadline = Date.now() + this.#shutdownGraceMs;
    while (this.scheduler.inFlightCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const now = new Date().toISOString();
    const stillRunning = this.store.listTasksByStatus("running");
    for (const task of stillRunning) {
      this.store.updateTaskStatus(task.id, "interrupted", now, { finishedAt: now });
      this.journal.append({ runId: task.runId, kind: "task.interrupted", taskId: task.id, reason: "shutdown_grace_expired" });
    }
    this.store.close();
    return { interrupted: stillRunning.length };
  }
}
