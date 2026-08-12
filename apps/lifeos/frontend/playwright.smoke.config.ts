// Separate Playwright configuration for the release smoke suite.
// Targets the deployed production URL (override with SMOKE_BASE_URL).
// Screenshots and traces are always captured for artifact upload.
// No webServer — the test hits the live deployment directly.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/smoke.spec.ts",
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? "https://lifeos-prod.taile48c9b.ts.net:8443",
    screenshot: "on",
    trace: "on",
  },
  // Chromium only unless a real browser-specific requirement appears.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
