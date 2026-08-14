/**
 * Per-run append-only event journal (07-brain-architecture.md section 7.6):
 * "the UI replays it; nothing is stored only in memory... Lost on crash: at
 * most the current in-flight stream deltas since the last journal flush
 * (flush per event)." One ndjson file per run under `<dataDir>/runs/`,
 * mirroring kernel/ledger.mjs's own append-only JSONL convention in ACC.
 *
 * m4-17 (07 section 7.9): "every journal and log line shall parse as JSON
 * with the 07 section 7.9 required fields" ({ts, level, run_id?, task_id?,
 * invocation_id?, event, fields}). append() below stamps those field
 * names ADDITIVELY, alongside the original `runId`/`kind`/`...extra` wire
 * shape m4-14's SSE stream and m4-15/16's Shell surface already parse --
 * a superset, not a rename, so no already-shipped consumer breaks.
 */
import fs from "node:fs";
import path from "node:path";
import type { LogLevel } from "./log.ts";

export interface JournalEventBase {
  runId: string;
  kind: string;
  taskId?: string;
  invocationId?: string;
  level?: LogLevel;
  [key: string]: unknown;
}

export type JournalEvent = JournalEventBase & {
  ts: string;
  level: LogLevel;
  run_id: string;
  task_id?: string;
  invocation_id?: string;
  event: string;
  fields: Record<string, unknown>;
};

export class RunJournal {
  #dir: string;

  constructor(dataDir: string) {
    this.#dir = path.join(dataDir, "runs");
    fs.mkdirSync(this.#dir, { recursive: true });
  }

  #pathFor(runId: string): string {
    return path.join(this.#dir, `${runId}.events.ndjson`);
  }

  /** Synchronous append with an explicit fsync-on-close (via 'a' flag +
   * writeSync) so "flush per event" is a real durability guarantee, not
   * just a buffered write that might still be lost on a hard crash. */
  append(event: JournalEventBase): void {
    // Splitting the original event's extra properties (everything beyond
    // runId/kind/taskId/invocationId/level) into `fields` gives 7.9's
    // `fields` bucket real content instead of an always-empty object,
    // without dropping any of them from the original flat shape below --
    // both views of the same data coexist in one line.
    const { runId, kind, taskId, invocationId, level, ...fields } = event;
    const full: JournalEvent = {
      ...event,
      ts: new Date().toISOString(),
      level: level ?? "info",
      run_id: runId,
      task_id: taskId,
      invocation_id: invocationId,
      event: kind,
      fields,
    };
    const fd = fs.openSync(this.#pathFor(event.runId as string), "a");
    try {
      fs.writeSync(fd, `${JSON.stringify(full)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Full replay for the UI (7.6: "the UI replays it"). Returns [] for a
   * run with no journal file yet rather than throwing. */
  read(runId: string): JournalEvent[] {
    const file = this.#pathFor(runId);
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JournalEvent);
  }
}
