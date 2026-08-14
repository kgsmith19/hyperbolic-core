#!/usr/bin/env node
// The Brain daemon's entrypoint (07 section 7.3): load config, open state
// store, reconcile, begin serving; SIGTERM drains with a grace period
// before exiting.
import { loadConfig } from "./config.ts";
import { BrainDaemon } from "./daemon.ts";
import { startServer } from "./server.ts";
import { createDispatchFn } from "./dispatch.ts";
import { ClaudeCodeAdapter } from "./adapters/claude-code.ts";
import { codexAdapter, geminiAdapter } from "./adapters/stub.ts";
import type { AdapterRegistry } from "./router.ts";

const config = loadConfig();

const adapters: AdapterRegistry = {
  "claude-code": new ClaudeCodeAdapter({
    kernelRunPath: config.kernelRunPath,
    accRoot: config.accRoot,
    accPolicy: config.accPolicy,
    accVault: config.accVault,
  }),
  codex: codexAdapter,
  gemini: geminiAdapter,
};

const daemon = new BrainDaemon({
  dbPath: config.dbPath,
  dataDir: config.dataDir,
  dispatchFactory: (store, journal) => createDispatchFn(store, { adapters, workspacesRoot: config.workspacesRoot, journal }),
});
await daemon.start();
const server = await startServer(daemon, config.port);
console.log(`services/brain listening on 127.0.0.1:${config.port}`);

let shuttingDown = false;
async function onSignal(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`services/brain: ${signal} received, draining`);
  server.close();
  const { interrupted } = await daemon.shutdown();
  console.log(`services/brain: shutdown complete, ${interrupted} task(s) marked interrupted`);
  process.exit(0);
}

process.on("SIGTERM", () => void onSignal("SIGTERM"));
process.on("SIGINT", () => void onSignal("SIGINT"));
