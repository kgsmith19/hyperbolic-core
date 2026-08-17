/**
 * BrainClient (07-brain-architecture.md section 7.8, m4-14): the
 * TypeScript client for the Brain's own HTTP origin (services/brain's
 * /api/brain/* routes), not PostgREST -- unlike registry.ts, whose
 * factory shape (two required args, `getAccessToken` re-invoked per
 * call, an optional third override) this module copies exactly. SSE
 * consumption (streamRunEvents) has no precedent elsewhere in this
 * package; SseLineParser is a small, pure, separately-exported parser
 * (same "pure and separately exported for unit testing" posture
 * registry.ts's buildListToolsParams already established) so the
 * wire-format logic is testable without a live server or a real
 * ReadableStream.
 */

export interface BrainRun {
  id: string;
  objective: string;
  autonomy: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrainTask {
  id: string;
  runId: string;
  title: string;
  status: string;
  contractJson: string;
  resultJson: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateRunParams {
  objective: string;
  repo: { url: string; ref: string };
  autonomy?: number;
  budget?: { tokens?: number };
  harness?: "claude-code" | "codex" | "gemini";
}

export interface CreateRunResult {
  runId: string;
  taskIds: string[];
  /** true when POST /runs returned 202 (parked awaiting approval, 07
   * section 7.7/7.8 -- never an error, just not yet dispatchable). */
  parked: boolean;
  reason: string | null;
}

export interface TaskActionResult {
  taskId: string;
  status: string;
}

export interface BrainEvent {
  runId: string;
  kind: string;
  ts: string;
  [key: string]: unknown;
}

export interface StreamRunEventsOptions {
  /** Resume from this journal index (the `id` of the last event this
   * client already processed) -- 07 section 7.8: "Last-Event-ID resumes
   * from the journal... reconnect after any gap replays losslessly." */
  lastEventId?: number;
  signal?: AbortSignal;
}

/** One grouping bucket from GET /api/brain/cost (m6-02,
 * services/brain/src/cost-summary.ts's `CostBucket` -- this type is that
 * module's JSON wire shape, copied field-for-field like every other
 * BrainClient type here). */
export interface CostBucket {
  key: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  usdEstimate: number;
}

export interface CostSummary {
  byRun: CostBucket[];
  byTask: CostBucket[];
  byHarness: CostBucket[];
  byDay: CostBucket[];
}

export interface BrainClient {
  createRun(params: CreateRunParams): Promise<CreateRunResult>;
  getRun(runId: string): Promise<{ run: BrainRun; tasks: BrainTask[] } | null>;
  approveTask(taskId: string): Promise<TaskActionResult>;
  rejectTask(taskId: string, reason?: string): Promise<TaskActionResult>;
  /** Consumes the SSE stream until the connection ends or `options.signal`
   * aborts it, invoking `onEvent` for each event in arrival order. */
  streamRunEvents(runId: string, onEvent: (event: BrainEvent, id: number | null) => void, options?: StreamRunEventsOptions): Promise<void>;
  health(): Promise<{ status: string }>;
  /** GET /api/brain/cost (m6-02): per-run/per-task/per-harness/per-day
   * cost breakdown, the granularity that exists ONLY in the Brain's own
   * SQLite store -- the platform `core` mirror never receives it (see
   * cost-summary.ts's header comment). `since` is an optional ISO-8601
   * timestamp. */
  getCostSummary(since?: string): Promise<CostSummary>;
}

export interface ParsedSseEvent {
  id: number | null;
  event: string | null;
  data: string;
}

/** A pure, incremental SSE wire-format parser (RFC 8895's `text/event-
 * stream` framing: `id:`/`event:`/`data:` fields, blank line dispatches
 * the accumulated event, `:`-prefixed lines are comments/heartbeats and
 * ignored). Multi-line `data:` fields are joined with `\n` per spec;
 * services/brain/src/sse.ts's own writer never emits multi-line data,
 * but this parser doesn't assume that of every future producer. */
export class SseLineParser {
  #buffer = "";
  #id: string | null = null;
  #event: string | null = null;
  #dataLines: string[] = [];

  /** Feeds a raw decoded text chunk; returns every complete event found
   * within it, in order. Partial lines/events are held internally until
   * a later push() completes them. */
  push(chunk: string): ParsedSseEvent[] {
    this.#buffer += chunk;
    const out: ParsedSseEvent[] = [];
    let idx: number;
    while ((idx = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, idx).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(idx + 1);

      if (line === "") {
        if (this.#dataLines.length > 0) {
          out.push({ id: this.#id !== null ? Number(this.#id) : null, event: this.#event, data: this.#dataLines.join("\n") });
        }
        this.#id = null;
        this.#event = null;
        this.#dataLines = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("id:")) this.#id = line.slice(3).trim();
      else if (line.startsWith("event:")) this.#event = line.slice(6).trim();
      else if (line.startsWith("data:")) this.#dataLines.push(line.slice(5).trim());
    }
    return out;
  }
}

export function createBrainClient(baseUrl: string, getAccessToken: () => Promise<string>): BrainClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function authedFetch(path: string, init: RequestInit = {}, allowedStatuses: number[] = []): Promise<Response> {
    // Fail closed before issuing any network request, matching this
    // package's own index.ts authedFetch contract: getAccessToken()
    // rejecting when there's no active session propagates untouched.
    const token = await getAccessToken();
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
    if (!res.ok && res.status !== 202 && !allowedStatuses.includes(res.status)) {
      const body = await res.text().catch(() => "");
      throw new Error(`brain-client: ${init.method ?? "GET"} ${path} failed with ${res.status}${body ? `: ${body}` : ""}`);
    }
    return res;
  }

  return {
    async createRun(params) {
      const res = await authedFetch("/api/brain/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = (await res.json()) as { run_id: string; task_id?: string; task_ids?: string[]; reason?: string };
      return {
        runId: body.run_id,
        taskIds: body.task_ids ?? (body.task_id ? [body.task_id] : []),
        parked: res.status === 202,
        reason: body.reason ?? null,
      };
    },

    async getRun(runId) {
      // 404 is an expected outcome here (an unknown/not-yet-visible run
      // id), not a transport failure, so it must reach this check instead
      // of authedFetch throwing on it first.
      const res = await authedFetch(`/api/brain/runs/${encodeURIComponent(runId)}`, {}, [404]);
      if (res.status === 404) return null;
      return (await res.json()) as { run: BrainRun; tasks: BrainTask[] };
    },

    async approveTask(taskId) {
      const res = await authedFetch(`/api/brain/tasks/${encodeURIComponent(taskId)}/approve`, { method: "POST" });
      const body = (await res.json()) as { task_id: string; status: string };
      return { taskId: body.task_id, status: body.status };
    },

    async rejectTask(taskId, reason) {
      const res = await authedFetch(`/api/brain/tasks/${encodeURIComponent(taskId)}/reject`, {
        method: "POST",
        headers: reason !== undefined ? { "content-type": "application/json" } : {},
        body: reason !== undefined ? JSON.stringify({ reason }) : undefined,
      });
      const body = (await res.json()) as { task_id: string; status: string };
      return { taskId: body.task_id, status: body.status };
    },

    async streamRunEvents(runId, onEvent, options = {}) {
      const token = await getAccessToken();
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (options.lastEventId !== undefined) headers["last-event-id"] = String(options.lastEventId);

      const res = await fetch(`${base}/api/brain/runs/${encodeURIComponent(runId)}/events`, { headers, signal: options.signal });
      if (!res.ok || !res.body) {
        throw new Error(`brain-client: GET /api/brain/runs/${runId}/events failed with ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseLineParser();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
            if (!evt.data) continue;
            try {
              onEvent(JSON.parse(evt.data) as BrainEvent, evt.id);
            } catch {
              // A malformed data line is a producer bug, not a reason to
              // kill the whole stream for every other event on it.
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    },

    async health() {
      // /api/brain/health, not /healthz: behind the shared one-origin route
      // table a bare /healthz is the SHELL's static health asset, so probing
      // it would report the Brain healthy while the daemon is down. The
      // server accepts this path unauthenticated in both deploy shapes.
      const res = await fetch(`${base}/api/brain/health`);
      return (await res.json()) as { status: string };
    },

    async getCostSummary(since) {
      const query = since ? `?since=${encodeURIComponent(since)}` : "";
      const res = await authedFetch(`/api/brain/cost${query}`);
      return (await res.json()) as CostSummary;
    },
  };
}
