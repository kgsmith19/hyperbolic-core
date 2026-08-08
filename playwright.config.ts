import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The CONTRACT suite: this UI against a REAL ACC server (gui/server.mjs from
// the ACC repo), sandboxed via ACC's own e2e fake seams — fake engine/usage/
// budget/runner, throwaway ACC_ROOT — so nothing here can touch live state or
// spawn a real claude. ACC_DIR points at a checkout of
// kgsmith19/agentic-command-center (default: sibling directory).
const ACC = path.resolve(process.env.ACC_DIR || "../agentic-command-center");
const dir = process.env.ACC_UI_E2E_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "acc-ui-e2e-"));
process.env.ACC_UI_E2E_DIR = dir;

// Routing fixture whose one route targets a real (sandbox) directory.
const routeDir = path.join(dir, "code", "guards-target");
fs.mkdirSync(routeDir, { recursive: true });
fs.writeFileSync(path.join(dir, "ROUTING.md"), "# routes\n```json\n" + JSON.stringify({
  routes: [{ label: "guards", path: routeDir, signals: ["guards", "hook"] }],
}) + "\n```\n");

export default defineConfig({
  testDir: "e2e",
  workers: 1, // specs share the one sandbox
  use: {
    baseURL: "http://127.0.0.1:5173",
    ...(process.env.ACC_PW_CHROMIUM ? { launchOptions: { executablePath: process.env.ACC_PW_CHROMIUM } } : {}),
  },
  webServer: [
    {
      command: `node ${path.join(ACC, "gui", "server.mjs")} --port 43117`,
      url: "http://127.0.0.1:43117/api/kernel-policy",
      reuseExistingServer: false,
      env: {
        ACC_POLICY: path.join(dir, "policy.json"),
        ACC_ROOT: dir,
        ACC_ENGINE: path.join(ACC, "gui", "e2e", "fake-engine.e2e.mjs"),
        ACC_USAGE: path.join(ACC, "gui", "e2e", "fake-usage.e2e.mjs"),
        ACC_BUDGET: path.join(ACC, "gui", "e2e", "fake-budget.e2e.mjs"),
        ACC_RUNNER: path.join(ACC, "gui", "e2e", "fake-runner.e2e.mjs"),
        ACC_ROUTING_MD: path.join(dir, "ROUTING.md"),
        ACC_LANE_DIR: path.join(dir, "lane"),
        ACC_GUI_E2E_DIR: dir, // the fakes keep their state here
      },
    },
    {
      command: "npm run dev -- --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      env: { ACC_API: "http://127.0.0.1:43117" },
    },
  ],
});
