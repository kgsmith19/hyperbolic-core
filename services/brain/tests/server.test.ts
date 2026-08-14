import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { BrainDaemon } from "../src/daemon.ts";
import { startServer } from "../src/server.ts";

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brain-server-"));
}

async function withServer<T>(run: (baseUrl: string, daemon: BrainDaemon) => Promise<T>): Promise<T> {
  const dataDir = tmpDataDir();
  const daemon = new BrainDaemon({ dbPath: path.join(dataDir, "brain.db"), dataDir });
  await daemon.start();
  const server = await startServer(daemon, 0);
  try {
    const { port } = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${port}`, daemon);
  } finally {
    server.close();
    await daemon.shutdown();
  }
}

test("GET /healthz returns 200 {status: ok, ...} while the store is writable", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; stateStoreWritable: boolean };
    assert.equal(body.status, "ok");
    assert.equal(body.stateStoreWritable, true);
  });
});

test("GET on an unknown route returns 404", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
  });
});

test("POST /healthz (wrong method) returns 404, not 200", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/healthz`, { method: "POST" });
    assert.equal(res.status, 404);
  });
});
