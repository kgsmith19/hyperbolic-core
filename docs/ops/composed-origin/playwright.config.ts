import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const here = import.meta.dirname;

export default defineConfig({
  testDir: here,
  testMatch: "composed-routing.spec.ts",
  outputDir: path.join(here, "test-results"),
  reporter: [
    ["line"],
    [
      "html",
      { open: "never", outputFolder: path.join(here, "playwright-report") },
    ],
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:18080",
    screenshot: process.env.E2E_PROOF ? "on" : "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node start-origin.mjs",
    cwd: here,
    // The public surface's unconditional health endpoint is only a process-
    // readiness signal. Every assertion targets 18080, the private surface.
    // This lets current main start cleanly and then fail on the missing
    // private listener/routes, which is the intended product RED.
    url: "http://127.0.0.1:18081/healthz",
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
