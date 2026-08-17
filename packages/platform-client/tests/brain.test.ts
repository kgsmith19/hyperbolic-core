import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrainClient, SseLineParser } from "../src/brain.ts";
import { jsonResponse } from "./support.ts";

const FIXTURE_URL = "https://brain.fixture.invalid";
const FIXTURE_TOKEN = "fixture.session.token";

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// --- SseLineParser: pure wire-format parsing --------------------------------

test("SseLineParser: parses a single complete id/event/data event", () => {
  const parser = new SseLineParser();
  const events = parser.push("id: 0\nevent: run.submitted\ndata: {\"kind\":\"run.submitted\"}\n\n");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { id: 0, event: "run.submitted", data: '{"kind":"run.submitted"}' });
});

test("SseLineParser: multi-line data fields are joined with \\n per spec", () => {
  const parser = new SseLineParser();
  const events = parser.push("data: line one\ndata: line two\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.data, "line one\nline two");
});

test("SseLineParser: buffers a partial event across multiple push() calls", () => {
  const parser = new SseLineParser();
  assert.deepEqual(parser.push("id: 1\nev"), []);
  assert.deepEqual(parser.push("ent: task.parked_for_approval\ndat"), []);
  const events = parser.push("a: {}\n\n");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { id: 1, event: "task.parked_for_approval", data: "{}" });
});

test("SseLineParser: a partial line held mid-token is not emitted until it completes", () => {
  const parser = new SseLineParser();
  assert.deepEqual(parser.push("id: 2\ndata: {\"a\":1"), []);
  const events = parser.push("}\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.data, '{"a":1}');
});

test("SseLineParser: comment/heartbeat lines (leading ':') are ignored, not dispatched as events", () => {
  const parser = new SseLineParser();
  const events = parser.push(": heartbeat\n\ndata: real\n\n");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.data, "real");
});

test("SseLineParser: a blank line with no accumulated data lines dispatches nothing", () => {
  const parser = new SseLineParser();
  const events = parser.push("id: 5\n\n");
  assert.equal(events.length, 0);
});

test("SseLineParser: id/event reset between events, so a later event without them reports null", () => {
  const parser = new SseLineParser();
  const events = parser.push("id: 0\nevent: e0\ndata: a\n\ndata: b\n\n");
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { id: 0, event: "e0", data: "a" });
  assert.deepEqual(events[1], { id: null, event: null, data: "b" });
});

test("SseLineParser: multiple complete events in one chunk are all returned, in order", () => {
  const parser = new SseLineParser();
  const events = parser.push("id: 0\ndata: a\n\nid: 1\ndata: b\n\nid: 2\ndata: c\n\n");
  assert.deepEqual(
    events.map((e) => [e.id, e.data]),
    [
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ],
  );
});

test("SseLineParser: handles CRLF line endings", () => {
  const parser = new SseLineParser();
  const events = parser.push("id: 0\r\nevent: e0\r\ndata: a\r\n\r\n");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { id: 0, event: "e0", data: "a" });
});

// --- createBrainClient: request shape ---------------------------------------

test("createRun: POSTs to /api/brain/runs with a bearer token and returns runId/taskIds for a 201", async () => {
  const spy = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, new URL(FIXTURE_URL).origin);
    assert.equal(url.pathname, "/api/brain/runs");
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${FIXTURE_TOKEN}`);
    assert.equal(headers.get("content-type"), "application/json");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.objective, "do the thing");
    return jsonResponse({ run_id: "run-1", task_ids: ["task-1"] }, 201);
  };

  const result = await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.createRun({ objective: "do the thing", repo: { url: "https://x", ref: "main" } });
  });

  assert.deepEqual(result, { runId: "run-1", taskIds: ["task-1"], parked: false, reason: null });
});

test("createRun: a 202 response reports parked:true with the server's reason", async () => {
  const spy = async () => jsonResponse({ run_id: "run-2", task_id: "task-2", reason: "autonomy exceeds propose-scope cap" }, 202);

  const result = await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.createRun({ objective: "x", repo: { url: "https://x", ref: "main" } });
  });

  assert.equal(result.parked, true);
  assert.equal(result.taskIds.length, 1);
  assert.equal(result.reason, "autonomy exceeds propose-scope cap");
});

test("createRun: a non-ok, non-202 response rejects with a descriptive error", async () => {
  const spy = async () => jsonResponse({ error: "missing objective" }, 400);

  await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await assert.rejects(
      () => client.createRun({ objective: "", repo: { url: "https://x", ref: "main" } }),
      /400/,
    );
  });
});

test("getRun: resolves null (not throw) on a 404", async () => {
  const spy = async () => new Response("not found", { status: 404 });

  const result = await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.getRun("does-not-exist");
  });

  assert.equal(result, null);
});

test("getRun: GETs /api/brain/runs/{id} and returns the run+tasks body", async () => {
  const spy = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/brain/runs/run-1");
    return jsonResponse({ run: { id: "run-1" }, tasks: [{ id: "task-1" }] });
  };

  const result = await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.getRun("run-1");
  });

  assert.equal(result?.run.id, "run-1");
  assert.equal(result?.tasks.length, 1);
});

test("approveTask: POSTs to /api/brain/tasks/{id}/approve", async () => {
  const spy = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/brain/tasks/task-1/approve");
    assert.equal(init?.method, "POST");
    return jsonResponse({ task_id: "task-1", status: "queued" });
  };

  const result = await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.approveTask("task-1");
  });

  assert.deepEqual(result, { taskId: "task-1", status: "queued" });
});

test("rejectTask: omits the JSON body entirely when no reason is given", async () => {
  const spy = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/brain/tasks/task-1/reject");
    assert.equal(init?.body, undefined);
    return jsonResponse({ task_id: "task-1", status: "rejected" });
  };

  const result = await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.rejectTask("task-1");
  });

  assert.deepEqual(result, { taskId: "task-1", status: "rejected" });
});

test("rejectTask: sends a JSON reason body when a reason is given", async () => {
  const spy = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), { reason: "not needed" });
    return jsonResponse({ task_id: "task-1", status: "rejected" });
  };

  await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await client.rejectTask("task-1", "not needed");
  });
});

test("health: GETs /api/brain/health unauthenticated (no bearer token required)", async () => {
  const spy = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/brain/health");
    assert.equal(init?.headers, undefined);
    return jsonResponse({ status: "ok" });
  };

  const result = await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.health();
  });

  assert.deepEqual(result, { status: "ok" });
});

test("getCostSummary: GETs /api/brain/cost with the bearer token, no since= param when omitted", async () => {
  const spy = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/brain/cost");
    assert.equal(url.search, "");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${FIXTURE_TOKEN}`);
    return jsonResponse({ byRun: [], byTask: [], byHarness: [], byDay: [] });
  };

  const result = await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.getCostSummary();
  });

  assert.deepEqual(result, { byRun: [], byTask: [], byHarness: [], byDay: [] });
});

test("getCostSummary: passes since= as an encoded querystring param when given", async () => {
  const spy = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("since"), "2026-01-01T00:00:00.000Z");
    return jsonResponse({ byRun: [], byTask: [], byHarness: [], byDay: [] });
  };

  await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await client.getCostSummary("2026-01-01T00:00:00.000Z");
  });
});

test("getCostSummary: the grouped buckets pass through untouched (no client-side reshaping to get subtly wrong)", async () => {
  const summary = {
    byRun: [{ key: "run-1", count: 2, inputTokens: 120, outputTokens: 55, cacheReadTokens: 10, usdEstimate: 0.6 }],
    byTask: [],
    byHarness: [],
    byDay: [],
  };
  const spy = async () => jsonResponse(summary);

  const result = await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    return client.getCostSummary();
  });

  assert.deepEqual(result, summary);
});

test("getAccessToken rejecting (no session) reaches zero network calls, fail-closed like AuthedFetch", async () => {
  let called = false;
  const spy = async () => {
    called = true;
    return jsonResponse({});
  };

  await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => {
      throw new Error("no active session");
    });
    await assert.rejects(() => client.approveTask("task-1"));
  });

  assert.equal(called, false);
});

// --- streamRunEvents: SSE consumption over a real ReadableStream -----------

function sseBodyStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

test("streamRunEvents: invokes onEvent for each parsed SSE event, in order, with parsed JSON data and id", async () => {
  const spy = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/brain/runs/run-1/events");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${FIXTURE_TOKEN}`);
    assert.equal(headers.has("last-event-id"), false);
    return new Response(
      sseBodyStream([
        "id: 0\nevent: run.submitted\ndata: {\"runId\":\"run-1\",\"kind\":\"run.submitted\",\"ts\":\"t0\"}\n\n",
        "id: 1\nevent: task.parked_for_approval\ndata: {\"runId\":\"run-1\",\"kind\":\"task.parked_for_approval\",\"ts\":\"t1\"}\n\n",
      ]),
      { status: 200 },
    );
  };

  const received: Array<{ id: number | null; kind: string }> = [];
  await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await client.streamRunEvents("run-1", (event, id) => {
      received.push({ id, kind: event.kind });
    });
  });

  assert.deepEqual(received, [
    { id: 0, kind: "run.submitted" },
    { id: 1, kind: "task.parked_for_approval" },
  ]);
});

test("streamRunEvents: sends a last-event-id header when options.lastEventId is set", async () => {
  const spy = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("last-event-id"), "1");
    return new Response(sseBodyStream(["id: 2\nevent: e2\ndata: {\"runId\":\"run-1\",\"kind\":\"e2\",\"ts\":\"t2\"}\n\n"]), { status: 200 });
  };

  const received: number[] = [];
  await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await client.streamRunEvents("run-1", (_event, id) => {
      if (id !== null) received.push(id);
    }, { lastEventId: 1 });
  });

  assert.deepEqual(received, [2]);
});

test("streamRunEvents: a malformed data line is skipped, not fatal to the rest of the stream", async () => {
  const spy = async () =>
    new Response(
      sseBodyStream([
        "id: 0\nevent: bad\ndata: not-json\n\n",
        "id: 1\nevent: good\ndata: {\"runId\":\"run-1\",\"kind\":\"good\",\"ts\":\"t1\"}\n\n",
      ]),
      { status: 200 },
    );

  const received: string[] = [];
  await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await client.streamRunEvents("run-1", (event) => {
      received.push(event.kind);
    });
  });

  assert.deepEqual(received, ["good"]);
});

test("streamRunEvents: a non-ok response rejects with a descriptive error", async () => {
  const spy = async () => new Response("nope", { status: 401 });

  await withPatchedFetch(spy, async () => {
    const client = createBrainClient(FIXTURE_URL, async () => FIXTURE_TOKEN);
    await assert.rejects(() => client.streamRunEvents("run-1", () => {}), /401/);
  });
});
