/**
 * Per-run append-only event journal (07-brain-architecture.md section 7.6):
 * "the UI replays it; nothing is stored only in memory... Lost on crash: at
 * most the current in-flight stream deltas since the last journal flush
 * (flush per event)." One ndjson file per run under `<dataDir>/runs/`,
 * mirroring kernel/ledger.mjs's own append-only JSONL convention in ACC.
 */
import fs from "node:fs";
import path from "node:path";

export interface JournalEventBase {
  runId: string;
  kind: string;
  [key: string]: unknown;
}

export type JournalEvent = JournalEventBase & { ts: string };

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
    const full: JournalEvent = { ...event, ts: new Date().toISOString() };
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
