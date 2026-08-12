import { defineConfig } from "@playwright/test";

// e2e proof against a REAL production build (`npm run build && npm run
// preview`), not the dev server -- this issue's own instructions: "Write
// and actually RUN this real e2e spec yourself against a real dev/preview
// build". reuseExistingServer: false, matching
// apps/agentic-command-center/ui/playwright.config.ts's own choice, so a
// stale build from a previous run can never be mistaken for this run's
// result.
export default defineConfig({
  testDir: "e2e",
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: process.env.E2E_PROOF ? "on" : "only-on-failure",
    trace: "retain-on-failure",
    // Same override hook as apps/agentic-command-center/ui/playwright.config.ts's
    // ACC_PW_CHROMIUM: point at the pre-installed Chromium binary explicitly
    // when the environment's own Playwright browser resolution doesn't
    // already find a matching revision.
    ...(process.env.SHELL_PW_CHROMIUM ? { launchOptions: { executablePath: process.env.SHELL_PW_CHROMIUM } } : {}),
  },
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
