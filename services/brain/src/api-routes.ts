/**
 * The /api/brain/* HTTP route handlers (m4-14, 07-brain-architecture.md
 * section 7.8 Programmatic). Reuses cli/verbs.ts's pure verb functions
 * (statusVerb/tasksVerb/approveVerb/rejectVerb) wherever the HTTP surface
 * needs the exact same read/mutation the CLI already implements (m4-13)
 * -- one service layer, per 7.8's own framing ("All three surfaces call
 * the same internal service layer; none has private capabilities.").
 * POST /runs is the one route with no CLI equivalent to call through:
 * it additionally enforces the brain:run:propose scope's autonomy cap,
 * which only exists for a scoped-agent-token caller, never the CLI.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrainStore } from "./store.ts";
import type { RunJournal } from "./journal.ts";
import type { BrainConfig } from "./config.ts";
import { submitRun } from "./run-service.ts";
import { determineApproval } from "./autonomy.ts";
import { parkForApproval } from "./approvals.ts";
import { statusVerb, tasksVerb, approveVerb, rejectVerb, cumulativeCostForRun } from "./cli/verbs.ts";
import { summarizeCostDetails } from "./cost-summary.ts";
import { BRAIN_RUN_PROPOSE_SCOPE, hasScope, type Principal } from "./auth.ts";

const BODY_CAP = 16 * 1024;

export function send(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk;
      if (data.length > BODY_CAP) {
        // Reject HERE, not from the `end` handler. destroy() emits `close`,
        // never `end` and (with no error argument) never `error` -- so an
        // over-cap body settled this promise on no path at all: the await
        // never returned and the route never answered. Verified against a
        // real node:http server.
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data.length ? JSON.parse(data) : {});
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    // Backstop for the other no-`end` finish: a client aborting mid-upload.
    // A no-op on the normal path, where `end` has already settled this.
    req.on("close", () => reject(new Error("request aborted before the body was received")));
    req.on("error", reject);
  });
}

interface CreateRunBody {
  objective?: unknown;
  repo?: { url?: unknown; ref?: unknown };
  autonomy?: unknown;
  budget?: { tokens?: unknown };
  harness?: unknown;
}

/** POST /api/brain/runs. 201 on real submission, 202 on parked (never an
 * error per 07 section 7.7/CLI table's exit-4 framing, HTTP's own
 * "accepted, not yet actioned" status), 400 on a malformed body, 422 on
 * a well-formed body that fails contract validation. */
export async function handleCreateRun(req: IncomingMessage, res: ServerResponse, store: BrainStore, journal: RunJournal | undefined, config: BrainConfig, principal: Principal): Promise<void> {
  let body: CreateRunBody;
  try {
    body = (await readJsonBody(req)) as CreateRunBody;
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : "invalid request body" });
    return;
  }

  if (typeof body.objective !== "string" || !body.objective) {
    send(res, 400, { error: "objective is required" });
    return;
  }
  if (typeof body.repo?.url !== "string" || typeof body.repo?.ref !== "string") {
    send(res, 400, { error: "repo.url and repo.ref are required" });
    return;
  }

  const requestedAutonomy = typeof body.autonomy === "number" ? body.autonomy : 0;
  const result = submitRun(
    store,
    {
      objective: body.objective,
      repo: { url: body.repo.url, ref: body.repo.ref },
      autonomy: requestedAutonomy,
      tokenBudget: typeof body.budget?.tokens === "number" ? body.budget.tokens : undefined,
      harnessPreferred: (body.harness as "claude-code" | "codex" | "gemini" | undefined) ?? undefined,
    },
    journal
  );

  if (!result.ok) {
    send(res, 422, { errors: result.errors });
    return;
  }

  const taskContract = result.contracts[0]!;
  let decision = determineApproval(taskContract, taskContract.autonomy, {
    cumulativeCostUsd: cumulativeCostForRun(store, result.run.id),
    perRunCeilingUsd: config.perRunUsdCeiling,
    repoAllowlist: config.repoAllowlist,
  });

  // 07 section 7.8: "brain:run:propose scope... forces autonomy<=1 and
  // parks anything higher for approval" -- unconditional, independent of
  // whatever determineApproval's own always-approve/per-level check
  // already decided (m4-14's own acceptance criterion is explicit that
  // *any* autonomy above 1 parks under this scope).
  if (principal.kind === "agent" && hasScope(principal.claims, BRAIN_RUN_PROPOSE_SCOPE) && taskContract.autonomy > 1) {
    decision = { needsApproval: true, reason: decision.reason ?? `${BRAIN_RUN_PROPOSE_SCOPE} scope caps autonomy at 1` };
  }

  if (decision.needsApproval) {
    const task = store.getTask(taskContract.task_id)!;
    parkForApproval(store, journal, task, decision.reason ?? "approval required", new Date().toISOString(), config.approvalTtlMs);
    send(res, 202, { run_id: result.run.id, task_id: task.id, status: "awaiting_approval", reason: decision.reason });
    return;
  }

  send(res, 201, { run_id: result.run.id, task_ids: result.tasks.map((t) => t.id) });
}

/** GET /api/brain/runs/{id}. */
export function handleGetRun(res: ServerResponse, store: BrainStore, runId: string): void {
  const result = statusVerb(store, runId);
  send(res, result.exitCode === 0 ? 200 : 404, result.json);
}

/** GET /api/brain/runs/{id}/tasks -- not in 07's own table verbatim (the
 * table lists GET /api/brain/runs/{id} only), but tasksVerb's richer
 * per-task verdict detail is useful over HTTP too and costs nothing
 * extra to expose at its own sub-path; the CLI's `brain tasks` verb
 * already established this is a distinct, useful query shape. */
export function handleGetRunTasks(res: ServerResponse, store: BrainStore, runId: string): void {
  const result = tasksVerb(store, runId);
  send(res, result.exitCode === 0 ? 200 : 404, result.json);
}

export function handleApproveTask(res: ServerResponse, store: BrainStore, journal: RunJournal | undefined, taskId: string): void {
  const result = approveVerb(store, journal, taskId);
  send(res, result.exitCode === 0 ? 200 : 404, result.json);
}

export function handleRejectTask(res: ServerResponse, store: BrainStore, journal: RunJournal | undefined, taskId: string, reason: string | undefined): void {
  const result = rejectVerb(store, journal, taskId, reason);
  send(res, result.exitCode === 0 ? 200 : 404, result.json);
}

/** GET /api/brain/cost (m6-02): the Shell dashboard's one read for
 * everything the platform `core` mirror cannot answer -- per-task and
 * per-harness breakdown, plus per-run and per-day (see cost-summary.ts's
 * own header comment for why this has to be a Brain API route rather than
 * a platform-session query). `since` is an optional ISO-8601 timestamp,
 * same param shape `brain cost --since` already established (cli/verbs.ts
 * costVerb) -- not reused directly because that verb returns raw rows
 * plus a single grand total, a different shape than the four grouped
 * breakdowns this route needs. */
export function handleGetCost(res: ServerResponse, store: BrainStore, since: string | undefined): void {
  const rows = store.listCostDetailsForSummary(since);
  send(res, 200, summarizeCostDetails(rows));
}
