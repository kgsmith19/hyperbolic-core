import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/smoke.spec.ts",
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    // m2-08: Vite's `base: '/life/'` (vite.config.ts) means the dev server
    // serves this zone under that path, not the origin root -- confirmed by
    // running `npm run dev` directly: it prints "Local: http://localhost:5173/life/",
    // and a plain GET "/" 302s rather than serving the app. `baseURL`'s own
    // path segment is a Playwright footgun (see e2e/app.spec.ts's own
    // comment): a `page.goto()` argument starting with "/" resolves against
    // the ORIGIN, discarding this path -- every `goto()` call in this suite
    // spells "/life/..." out in full rather than relying on this value's
    // path component to be honored.
    baseURL: "http://localhost:5173",
    screenshot: process.env.E2E_PROOF ? "on" : "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173/life/",
    reuseExistingServer: !process.env.CI,
    // Matches ci.yml's frontend job env exactly (obviously-fake, no real
    // project reachable or needed -- every request this suite makes against
    // Supabase Auth is intercepted by `signIn()`/`page.route` below).
    // VITE_API_URL is deliberately UNSET: src/api/client.ts's default
    // ("/life/api", same-origin relative) is real behavior this suite
    // exercises, not a value to paper over with an absolute mock origin.
    env: {
      VITE_SUPABASE_URL: "https://test.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "test-public-anon-key",
    },
  },
});
