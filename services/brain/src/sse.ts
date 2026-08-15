/**
 * SSE streaming of a run's journal (07-brain-architecture.md section 7.8:
 * "Transport: SSE per run... typed events... heartbeat every 15 s" /
 * "Reconnect: Last-Event-ID resumes from the journal (7.6); the journal
 * is the source, so reconnect after any gap replays losslessly.").
 *
 * Event naming: 7.8 names six categories (run.status, task.status,
 * harness.delta, verify.result, approval.request, cost.tick), but
 * today's journal.ts events use more specific `kind` strings
 * (run.submitted, task.parked_for_approval, task.harness_fallback, ...)
 * and nothing yet journals a harness.delta or verify.result event at all
 * (m4-10/m4-11 didn't add journal calls for those). Rather than fabricate
 * a mapping not backed by real event granularity, the SSE `event:` field
 * is the journal's own `kind` string verbatim -- honest about what's
 * actually produced today; a future issue can add the 7.8 taxonomy
 * mapping once harness.delta/verify.result have real producers.
 */
import type { ServerResponse } from "node:http";
import type { JournalEvent, RunJournal } from "./journal.ts";

const SSE_HEARTBEAT_MS = 15_000;
const SSE_POLL_MS = 250;

export function writeSseEvent(res: ServerResponse, id: number, event: JournalEvent): void {
  res.write(`id: ${id}\n`);
  res.write(`event: ${event.kind}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function writeSseHeartbeat(res: ServerResponse): void {
  res.write(": heartbeat\n\n");
}

export interface StreamRunEventsOptions {
  /** Parsed from the incoming `Last-Event-ID` header, if present --
   * everything at or before this index was already delivered to this
   * client on a prior connection. */
  lastEventId?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

/** Streams a run's journal as SSE. Every event id is its 0-based index
 * into `journal.read(runId)`'s own array -- stable across reconnects
 * because the journal file is append-only and never reordered, which is
 * exactly what makes "resume from Last-Event-ID" lossless: any index
 * already sent is skipped, everything after it (already-written-but-
 * not-yet-sent, or written after this connection opens) is delivered in
 * order, and nothing the journal ever durably held can be missed.
 * Returns a cleanup function the caller invokes on client disconnect. */
export function streamRunEvents(res: ServerResponse, journal: RunJournal, runId: string, options: StreamRunEventsOptions = {}): () => void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  // Flushes headers immediately so a client isn't left waiting on the
  // first real event or the first 15s heartbeat, whichever comes first.
  res.flushHeaders?.();

  let sentCount = options.lastEventId !== undefined && options.lastEventId >= 0 ? options.lastEventId + 1 : 0;

  const sendNew = (): void => {
    const events = journal.read(runId);
    for (let i = sentCount; i < events.length; i++) {
      writeSseEvent(res, i, events[i]!);
    }
    sentCount = events.length;
  };

  sendNew();

  const pollTimer = setInterval(sendNew, options.pollMs ?? SSE_POLL_MS);
  const heartbeatTimer = setInterval(() => writeSseHeartbeat(res), options.heartbeatMs ?? SSE_HEARTBEAT_MS);
  pollTimer.unref();
  heartbeatTimer.unref();

  return () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
  };
}

/** Parses an incoming `Last-Event-ID` header value; undefined for
 * missing/non-numeric (treated as "no prior connection", i.e. replay
 * from the start). */
export function parseLastEventId(header: string | string[] | undefined): number | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
