// Playwright configuration for the D-04 dashboard smoke spec.
// Mirrors apps/toolbelt/apps/prompt-organizer/playwright.config.mjs (the
// existing precedent for browser testing in this monorepo) so the two
// suites share one install/invocation pattern; this app has no Node test
// runner of its own to keep separate from, since `tools/check.sh` is
// entirely Python.
//
// Run:  npx playwright test --config playwright.config.mjs
// Env:  PLAYWRIGHT_BASE_URL  (default: http://127.0.0.1:8787)

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // One Chromium browser only, matching the Prompt Organizer precedent —
  // this is a smoke spec, not a cross-browser compatibility suite.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Capture a screenshot on failure and a full trace for every run so CI
  // artifacts always contain evidence.
  use: {
    screenshot: "only-on-failure",
    trace: "on",
    video: "off",
    // 8787 is the dashboard's documented loopback-only port (AGENTS.md,
    // docs/planning/05-f-network-checker.md section 5, D-04).
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8787",
  },
  outputDir: "test-results",
  reporter: [["html", { outputFolder: "playwright-report", open: "never" }]],
  // No retries in CI — a flaky browser test should be fixed, not silently
  // retried, so failures surface immediately.
  retries: 0,
  timeout: 60_000,
});
