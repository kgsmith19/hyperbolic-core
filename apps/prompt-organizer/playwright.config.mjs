// Playwright configuration for the E2E acceptance suite.
// Kept separate from the Node built-in test runner used by the fast PR Gate
// (`node --test "tests/*.test.mjs"`) so the two suites never interfere.
//
// Run:  npx playwright test --config playwright.config.mjs
// Env:  PLAYWRIGHT_BASE_URL  (default: http://localhost:8812)

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // One Chromium browser only — Issue #18 acceptance criterion.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Capture a screenshot on failure and a full trace for every run so CI
  // artifacts always contain evidence (Issue #18 acceptance criterion).
  use: {
    screenshot: "only-on-failure",
    trace: "on",
    video: "off",
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8812",
  },
  outputDir: "test-results",
  reporter: [["html", { outputFolder: "playwright-report", open: "never" }]],
  // No retries in CI — a flaky browser test should be fixed, not silently
  // retried, so failures surface immediately.
  retries: 0,
  // Timeout per test: 60 s accommodates Supabase auth latency and cold-start.
  timeout: 60_000,
});
