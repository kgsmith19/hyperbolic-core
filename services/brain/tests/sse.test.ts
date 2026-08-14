import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunJournal } from "../src/journal.ts";
import { streamRunEvents, parseLastEventId, writeSseEvent, writeSseHeartbeat } from "../src/sse.ts";

function tmpJournal(): RunJournal {
  return new RunJournal(fs.mkdtempSync(path.join(os.tmpdir(), "brain-sse-")));
}

/** A minimal fake http.ServerResponse capturing every write() call and
 * writeHead() call -- enough surface for streamRunEvents/writeSseEvent
 * without spinning up a real HTTP server for every test. */
function fakeResponse() {
  const writes: string[] = [];
  let headWritten: { code: number; headers: Record<string, string> } | null = null;
  return {
    writeHead(code: number, headers: Record<string, string>) {
      headWritten = { code, headers };
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    flushHeaders() {},
    get writes() {
      return writes;
    },
    get headWritten() {
      return headWritten;
    },
  };
}

test("parseLastEventId: undefined for missing or non-numeric headers", () => {
  assert.equal(parseLastEventId(undefined), undefined);
  assert.equal(parseLastEventId("not-a-number"), undefined);
  assert.equal(parseLastEventId("-1"), undefined);
});

test("parseLastEventId: parses a valid numeric header, including from an array (duplicate headers)", () => {
  assert.equal(parseLastEventId("3"), 3);
  assert.equal(parseLastEventId(["5", "9"]), 5);
  assert.equal(parseLastEventId("0"), 0);
});

test("writeSseEvent: writes id/event/data lines per the SSE wire format", () => {
  const res = fakeResponse();
  writeSseEvent(res as never, 2, { runId: "r1", kind: "run.submitted", ts: "2026-01-01T00:00:00.000Z" });
  const out = res.writes.join("");
  assert.match(out, /^id: 2\n/);
  assert.match(out, /event: run\.submitted\n/);
  assert.match(out, /data: \{.*"kind":"run\.submitted".*\}\n\n$/);
});

test("writeSseHeartbeat: a comment line, ignored by EventSource parsers but keeps the connection alive", () => {
  const res = fakeResponse();
  writeSseHeartbeat(res as never);
  assert.equal(res.writes[0], ": heartbeat\n\n");
});

test("streamRunEvents: a fresh connection (no Last-Event-ID) replays every existing journal event in order", () => {
  const journal = tmpJournal();
  journal.append({ runId: "run-1", kind: "run.submitted" });
  journal.append({ runId: "run-1", kind: "task.parked_for_approval" });

  const res = fakeResponse();
  const cleanup = streamRunEvents(res as never, journal, "run-1", { pollMs: 10_000, heartbeatMs: 10_000 });
  try {
    assert.equal(res.headWritten?.code, 200);
    assert.equal(res.headWritten?.headers["content-type"], "text/event-stream");
    const out = res.writes.join("");
    assert.match(out, /id: 0\n/);
    assert.match(out, /id: 1\n/);
    assert.match(out, /event: run\.submitted/);
    assert.match(out, /event: task\.parked_for_approval/);
  } finally {
    cleanup();
  }
});

test("streamRunEvents: reconnecting with Last-Event-ID only replays events AFTER that index -- lossless, gap-free resume", () => {
  const journal = tmpJournal();
  journal.append({ runId: "run-1", kind: "e0" });
  journal.append({ runId: "run-1", kind: "e1" });
  journal.append({ runId: "run-1", kind: "e2" });

  const res = fakeResponse();
  // Client already received index 0 and 1 on a prior connection.
  const cleanup = streamRunEvents(res as never, journal, "run-1", { lastEventId: 1, pollMs: 10_000, heartbeatMs: 10_000 });
  try {
    const out = res.writes.join("");
    assert.equal(out.includes("event: e0"), false, "already-delivered events must not be resent");
    assert.equal(out.includes("event: e1"), false, "already-delivered events must not be resent");
    assert.match(out, /event: e2/);
    assert.match(out, /id: 2\n/);
  } finally {
    cleanup();
  }
});

test("streamRunEvents: a subsequent poll picks up events written after the connection opened", async () => {
  const journal = tmpJournal();
  journal.append({ runId: "run-1", kind: "e0" });

  const res = fakeResponse();
  const cleanup = streamRunEvents(res as never, journal, "run-1", { pollMs: 20, heartbeatMs: 10_000 });
  try {
    assert.equal(res.writes.join("").includes("event: e1"), false);
    journal.append({ runId: "run-1", kind: "e1" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.match(res.writes.join(""), /event: e1/);
  } finally {
    cleanup();
  }
});

test("streamRunEvents: cleanup() stops further polling (no writes after cleanup, even if the journal grows)", async () => {
  const journal = tmpJournal();
  journal.append({ runId: "run-1", kind: "e0" });

  const res = fakeResponse();
  const cleanup = streamRunEvents(res as never, journal, "run-1", { pollMs: 20, heartbeatMs: 10_000 });
  cleanup();
  const writesAtCleanup = res.writes.length;

  journal.append({ runId: "run-1", kind: "e1" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(res.writes.length, writesAtCleanup, "no further writes after cleanup");
});

test("streamRunEvents: heartbeats are sent on their own interval, independent of new journal events", async () => {
  const journal = tmpJournal();
  const res = fakeResponse();
  const cleanup = streamRunEvents(res as never, journal, "run-1", { pollMs: 10_000, heartbeatMs: 20 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(res.writes.some((w) => w === ": heartbeat\n\n"));
  } finally {
    cleanup();
  }
});
