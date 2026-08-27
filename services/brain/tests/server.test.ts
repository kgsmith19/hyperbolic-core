import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { BrainDaemon } from "../src/daemon.ts";
import { startServer } from "../src/server.ts";
import type { BrainConfig } from "../src/config.ts";
import { BRAIN_RUN_PROPOSE_SCOPE } from "../src/auth.ts";
import { generateEcKeyPair, signJwt } from "./support.ts";
import type { PrivateKey } from "./support.ts";

const ISSUER = "test-issuer";
const AUDIENCE = "brain";

function signToken(privateKey: PrivateKey, scopes: string[]): string {
  const nowS = Math.floor(Date.now() / 1000);
  return signJwt(
    privateKey,
    { alg: "ES256", typ: "JWT" },
    { iss: ISSUER, aud: AUDIENCE, sub: "agent:test", scopes, iat: nowS, exp: nowS + 3600 },
  );
}

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-server-"));
}

interface ServerFixture {
  baseUrl: string;
  daemon: BrainDaemon;
  token: string;
  proposeToken: string;
}

async function withServer<T>(run: (fixture: ServerFixture) => Promise<T>, configOverrides: Partial<BrainConfig> = {}): Promise<T> {
  const dataDir = tmpDataDir();
  const { publicKeyPem, privateKey } = generateEcKeyPair();
  const daemon = new BrainDaemon({ dbPath: path.join(dataDir, "brain.db"), dataDir });
  await daemon.start();

  const config: BrainConfig = {
    // Required by BrainConfig and missing from this fixture: it was building a
    // config loadConfig() can never produce, which nothing caught while these
    // tests sat outside any type-check program.
    evalsCasesDir: path.join(dataDir, "eval-cases"),
    port: 0,
    dbPath: path.join(dataDir, "brain.db"),
    dataDir,
    workspacesRoot: "/workspaces",
    kernelRunPath: "/nonexistent/kernel/run.mjs",
    accRoot: "/nonexistent/acc-root",
    accPolicy: "/nonexistent/acc-root/policy.json",
    accVault: "/nonexistent/acc-root/vault.json",
    repoAllowlist: [],
    perRunUsdCeiling: 5,
    approvalTtlMs: 7 * 24 * 60 * 60 * 1000,
    repoRoot: "/nonexistent/repo-root",
    agentTokenPublicKeyPem: publicKeyPem,
    agentTokenIssuer: ISSUER,
    agentTokenAudience: AUDIENCE,
    ...configOverrides,
  };

  const server = await startServer(daemon, config);
  try {
    const { port } = server.address() as AddressInfo;
    const token = signToken(privateKey, []);
    const proposeToken = signToken(privateKey, [BRAIN_RUN_PROPOSE_SCOPE]);
    return await run({ baseUrl: `http://127.0.0.1:${port}`, daemon, token, proposeToken });
  } finally {
    server.close();
    await daemon.shutdown();
  }
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } };
}

// --- health (unauthenticated) --------------------------------------------

test("GET /healthz returns 200 {status: ok, ...} while the store is writable, no auth required", async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; stateStoreWritable: boolean };
    assert.equal(body.status, "ok");
    assert.equal(body.stateStoreWritable, true);
  });
});

test("GET /health is the same route -- the compatibility alias from the former per-path topology", async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  });
});

test("GET /api/brain/health is the same route nginx forwards for shared-origin health", async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/brain/health`);
    assert.equal(res.status, 200);
  });
});

test("GET on an unknown route returns 404", async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
  });
});

test("POST /healthz (wrong method) returns 404, not 200", async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/healthz`, { method: "POST" });
    assert.equal(res.status, 404);
  });
});

// --- auth gating (m4-14's own acceptance criterion) ------------------

test("every /api/brain/* route returns 401 without a credential, fast (SH-4: under 50ms)", async () => {
  await withServer(async ({ baseUrl }) => {
    const routes: Array<[string, string]> = [
      ["POST", "/api/brain/runs"],
      ["GET", "/api/brain/runs/nope"],
      ["GET", "/api/brain/runs/nope/tasks"],
      ["GET", "/api/brain/runs/nope/events"],
      ["GET", "/api/brain/cost"],
      ["POST", "/api/brain/tasks/nope/approve"],
      ["POST", "/api/brain/tasks/nope/reject"],
    ];
    for (const [method, route] of routes) {
      const start = performance.now();
      const res = await fetch(`${baseUrl}${route}`, { method });
      const elapsedMs = performance.now() - start;
      assert.equal(res.status, 401, `${method} ${route}`);
      assert.ok(elapsedMs < 50, `${method} ${route} took ${elapsedMs.toFixed(1)}ms, expected < 50ms`);
    }
  });
});

test("a garbage bearer token is also 401, not a 500", async () => {
  await withServer(async ({ baseUrl }) => {
    const res = await fetch(`${baseUrl}/api/brain/runs/nope`, authed("garbage-not-a-jwt"));
    assert.equal(res.status, 401);
  });
});

// --- POST /api/brain/runs -----------------------------------------------

test("POST /api/brain/runs: a valid request at autonomy 2 creates and returns 201", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const res = await fetch(
      `${baseUrl}/api/brain/runs`,
      authed(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "ship it", repo: { url: "https://example.invalid/repo", ref: "main" }, autonomy: 2 }),
      })
    );
    const body = (await res.json()) as { run_id: string; task_ids: string[] };
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.ok(body.run_id);
    assert.equal(body.task_ids.length, 1);
  });
});

test("POST /api/brain/runs: default autonomy (0) parks awaiting approval, 202", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const res = await fetch(
      `${baseUrl}/api/brain/runs`,
      authed(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "ship it", repo: { url: "https://example.invalid/repo", ref: "main" } }),
      })
    );
    assert.equal(res.status, 202);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "awaiting_approval");
  });
});

test("POST /api/brain/runs: missing objective is 400", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const res = await fetch(`${baseUrl}/api/brain/runs`, authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
    assert.equal(res.status, 400);
  });
});

test("POST /api/brain/runs: brain:run:propose scope caps autonomy at 1 -- autonomy 2 parks even though an owner/plain-agent request at that level wouldn't", async () => {
  await withServer(async ({ baseUrl, proposeToken }) => {
    const res = await fetch(
      `${baseUrl}/api/brain/runs`,
      authed(proposeToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "ship it", repo: { url: "https://example.invalid/repo", ref: "main" }, autonomy: 2 }),
      })
    );
    assert.equal(res.status, 202);
    const body = (await res.json()) as { reason: string };
    assert.match(body.reason, new RegExp(BRAIN_RUN_PROPOSE_SCOPE.replace(/[:.]/g, "\\$&")));
  });
});

test("POST /api/brain/runs: brain:run:propose scope at autonomy 1 does NOT park (only ABOVE 1 is capped)", async () => {
  await withServer(async ({ baseUrl, proposeToken }) => {
    const res = await fetch(
      `${baseUrl}/api/brain/runs`,
      authed(proposeToken, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "read only review", repo: { url: "https://example.invalid/repo", ref: "main" }, autonomy: 1 }),
      })
    );
    // Autonomy 1 (A1 read) with a default commit-type deliverable still
    // requires approval on its OWN per-level merits (autonomy.ts:
    // A1 permits only no-write-deliverable tasks) -- this proves the
    // propose-scope check didn't ADD an unwanted park at exactly 1, by
    // checking the reason text is the normal per-level one, not the
    // scope-specific one.
    const body = (await res.json()) as { reason?: string };
    if (res.status === 202) {
      assert.doesNotMatch(body.reason ?? "", new RegExp(BRAIN_RUN_PROPOSE_SCOPE.replace(/[:.]/g, "\\$&")));
    }
  });
});

// --- GET /api/brain/runs/{id}, /tasks -----------------------------------

test("GET /api/brain/runs/{id}: 404 for an unknown run, 200 with the run+tasks for a known one", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const notFound = await fetch(`${baseUrl}/api/brain/runs/nope`, authed(token));
    assert.equal(notFound.status, 404);

    const created = await fetch(
      `${baseUrl}/api/brain/runs`,
      authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "x", repo: { url: "https://example.invalid/repo", ref: "main" }, autonomy: 2 }) })
    );
    const { run_id } = (await created.json()) as { run_id: string };

    const res = await fetch(`${baseUrl}/api/brain/runs/${run_id}`, authed(token));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { run: { id: string }; tasks: unknown[] };
    assert.equal(body.run.id, run_id);
    assert.equal(body.tasks.length, 1);

    const tasksRes = await fetch(`${baseUrl}/api/brain/runs/${run_id}/tasks`, authed(token));
    assert.equal(tasksRes.status, 200);
  });
});

// --- GET /api/brain/cost (m6-02) -----------------------------------------

test("GET /api/brain/cost: grouped summary over seeded run/task/invocation/cost rows, and since= filters it", async () => {
  await withServer(async ({ baseUrl, token, daemon }) => {
    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-02T00:00:00.000Z";
    daemon.store.insertRun({ id: "run-1", objective: "x", autonomy: 2, status: "completed", createdAt: now, updatedAt: now });
    daemon.store.insertTask({ id: "task-1", runId: "run-1", title: "t", status: "succeeded", contractJson: "{}", resultJson: null, createdAt: now, updatedAt: now, startedAt: now, finishedAt: now });
    daemon.store.insertInvocation({ id: "inv-1", taskId: "task-1", harness: "claude-code", sessionId: null, status: "completed", startedAt: now, finishedAt: now });
    daemon.store.insertCost({ id: "cost-1", taskId: "task-1", invocationId: "inv-1", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, usdEstimate: 0.5, recordedAt: now });
    daemon.store.insertCost({ id: "cost-2", taskId: "task-1", invocationId: "inv-1", inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, usdEstimate: 0.1, recordedAt: later });

    const res = await fetch(`${baseUrl}/api/brain/cost`, authed(token));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { byRun: { key: string; count: number; usdEstimate: number }[]; byTask: unknown[]; byHarness: unknown[]; byDay: unknown[] };
    assert.equal(body.byRun.length, 1);
    assert.equal(body.byRun[0]!.key, "run-1");
    assert.equal(body.byRun[0]!.count, 2);
    assert.equal(body.byRun[0]!.usdEstimate, 0.6);
    assert.equal(body.byDay.length, 2);

    const filtered = await fetch(`${baseUrl}/api/brain/cost?since=${encodeURIComponent(later)}`, authed(token));
    const filteredBody = (await filtered.json()) as { byRun: { count: number }[] };
    assert.equal(filteredBody.byRun[0]!.count, 1);
  });
});

// --- approve / reject ------------------------------------------------

test("POST /api/brain/tasks/{id}/approve: 404 for an id with nothing pending, 200 once parked", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const noneRes = await fetch(`${baseUrl}/api/brain/tasks/nope/approve`, authed(token, { method: "POST" }));
    assert.equal(noneRes.status, 404);

    const created = await fetch(
      `${baseUrl}/api/brain/runs`,
      authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "x", repo: { url: "https://example.invalid/repo", ref: "main" } }) })
    );
    const { task_id } = (await created.json()) as { task_id: string };

    const res = await fetch(`${baseUrl}/api/brain/tasks/${task_id}/approve`, authed(token, { method: "POST" }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "pending");
  });
});

test("POST /api/brain/tasks/{id}/reject: accepts an optional JSON reason", async () => {
  await withServer(async ({ baseUrl, token }) => {
    const created = await fetch(
      `${baseUrl}/api/brain/runs`,
      authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "x", repo: { url: "https://example.invalid/repo", ref: "main" } }) })
    );
    const { task_id } = (await created.json()) as { task_id: string };

    const res = await fetch(`${baseUrl}/api/brain/tasks/${task_id}/reject`, authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "not needed" }) }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "cancelled");
  });
});

// --- SSE: the m4-14 headline acceptance criterion -----------------------

async function readSseLines(res: Response, count: number, signal: AbortSignal): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const lines: string[] = [];
  while (lines.length < count && !signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("id: ")) lines.push(line);
    }
  }
  await reader.cancel().catch(() => {});
  return lines;
}

test("GET /api/brain/runs/{id}/events: a fresh connection replays every journal event as SSE", async () => {
  await withServer(async ({ baseUrl, token, daemon }) => {
    const created = await fetch(
      `${baseUrl}/api/brain/runs`,
      authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "x", repo: { url: "https://example.invalid/repo", ref: "main" }, autonomy: 2 }) })
    );
    const { run_id } = (await created.json()) as { run_id: string };
    void daemon;

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/brain/runs/${run_id}/events`, authed(token, { signal: controller.signal }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");

    const idLines = await readSseLines(res, 1, controller.signal);
    controller.abort();
    assert.equal(idLines[0], "id: 0", "the run.submitted event journaled at submission is replayed first");
  });
});

test("GET /api/brain/runs/{id}/events with Last-Event-ID: reconnect replays losslessly, no duplicates and no gaps", async () => {
  await withServer(async ({ baseUrl, token, daemon }) => {
    // Default autonomy (0) parks in the same POST /runs call -- that
    // single request journals TWO events (run.submitted at index 0,
    // task.parked_for_approval at index 1), giving a deterministic
    // second event without any follow-up call.
    const created = await fetch(
      `${baseUrl}/api/brain/runs`,
      authed(token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "x", repo: { url: "https://example.invalid/repo", ref: "main" } }) })
    );
    const { run_id } = (await created.json()) as { run_id: string };
    void daemon;

    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/brain/runs/${run_id}/events`, authed(token, { headers: { "Last-Event-ID": "0" }, signal: controller.signal }));
    const lines = await readSseLines(res, 1, controller.signal);
    controller.abort();

    assert.equal(lines.includes("id: 0"), false, "already-delivered index 0 must not be resent");
    assert.equal(lines[0], "id: 1", "resume continues from the very next index, no gap");
  });
});
