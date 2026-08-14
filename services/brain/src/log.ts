/**
 * Structured ndjson process log (07-brain-architecture.md section 7.9):
 * "Log schema (ndjson, every line): {ts, level, run_id?, task_id?,
 * invocation_id?, event, fields}; secrets structurally impossible in logs
 * because values never enter the Brain process."
 *
 * Distinct from journal.ts's per-run event journal (7.6: "the UI replays
 * it") -- that file is the UI's lossless-replay wire format, already
 * shipped and consumed by m4-14's SSE stream and m4-15/16's Shell surface
 * (a different, earlier-frozen shape). This module is the operator-facing
 * process log 7.9 actually specifies: one ndjson file for the whole
 * daemon (not per-run), queryable the same way journal.ts's own header
 * comment describes for its file ("brain logs/cost/status --json plus
 * direct SQLite for ad hoc queries", 7.9's own "Queryable" bullet).
 */
import fs from "node:fs";
import path from "node:path";
import { scrubText, scrubValue } from "./scrubber.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogIds {
  runId?: string;
  taskId?: string;
  invocationId?: string;
}

/** The exact wire shape 7.9 requires, one object per line. */
export interface LogLine {
  ts: string;
  level: LogLevel;
  run_id?: string;
  task_id?: string;
  invocation_id?: string;
  event: string;
  fields: Record<string, unknown>;
}

export class BrainLogger {
  #file: string;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, "brain.log.ndjson");
    fs.mkdirSync(dataDir, { recursive: true });
  }

  get file(): string {
    return this.#file;
  }

  /** Synchronous append + fsync, same durability posture as journal.ts's
   * own append() ("flush per event", 7.6) -- a process log is only useful
   * for post-mortem debugging if it survives the crash it is meant to
   * explain. */
  /** m4-18 (07 section 7.10): every field passes through the scrubber
   * before it ever reaches disk -- unconditional, not opt-in, since a
   * caller forgetting to scrub is exactly the failure mode this exists
   * to cover. */
  log(level: LogLevel, event: string, ids: LogIds = {}, fields: Record<string, unknown> = {}): void {
    const line: LogLine = {
      ts: new Date().toISOString(),
      level,
      event: scrubText(event),
      fields: scrubValue(fields) as Record<string, unknown>,
    };
    if (ids.runId !== undefined) line.run_id = ids.runId;
    if (ids.taskId !== undefined) line.task_id = ids.taskId;
    if (ids.invocationId !== undefined) line.invocation_id = ids.invocationId;

    const fd = fs.openSync(this.#file, "a");
    try {
      fs.writeSync(fd, `${JSON.stringify(line)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
