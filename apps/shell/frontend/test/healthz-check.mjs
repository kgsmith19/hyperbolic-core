#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(appRoot, "public", "healthz");
const builtPath = path.join(appRoot, "dist", "healthz");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function availablePort() {
  const server = net.createServer();
  server.unref();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  invariant(address && typeof address === "object", "could not allocate a preview port");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitFor(url, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    invariant(child.exitCode === null && child.signalCode === null, "Vite preview exited before becoming ready");
    try {
      return await fetch(url, { signal: AbortSignal.timeout(1_000) });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Vite preview did not become ready within ${timeoutMs}ms`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Vite preview did not stop")), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function main() {
  if (process.env.NODE_TEST_CONTEXT) return;
  invariant(existsSync(sourcePath), "public/healthz is missing");
  invariant(existsSync(builtPath), "dist/healthz is missing; build the Shell first");

  const expected = readFileSync(sourcePath, "utf8");
  invariant(readFileSync(builtPath, "utf8") === expected, "the built health asset differs from its source");

  const port = await availablePort();
  const viteEntry = fileURLToPath(import.meta.resolve("vite"));
  const viteBin = path.resolve(path.dirname(viteEntry), "../../bin/vite.js");
  const child = spawn(
    process.execPath,
    [viteBin, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: appRoot, stdio: "ignore" }
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  try {
    const response = await waitFor(`http://127.0.0.1:${port}/healthz`, child);
    const body = await response.text();
    invariant(response.status === 200, `/healthz returned ${response.status}`);
    invariant(body === expected, "/healthz returned the SPA fallback instead of the static asset");
    invariant(!response.headers.get("content-type")?.startsWith("text/html"), "/healthz was served as HTML");
    console.log("[healthz-check] PASS");
  } finally {
    await stop(child);
  }
}

main().catch((error) => {
  console.error(`[healthz-check] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
