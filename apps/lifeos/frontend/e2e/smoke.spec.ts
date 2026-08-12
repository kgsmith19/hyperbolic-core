// Release smoke — exercises the REAL deployed UI against the REAL backend.
// No API mocks, no fake sessions. Uses a dedicated test account whose
// credentials are injected via SMOKE_EMAIL / SMOKE_PASSWORD env vars.
//
// Highest-value read-only journey: sign in → backend health check visible →
// Browse page renders at least one entity returned by the live API.
// Nothing is written, so no production data is mutated.
//
// Run with: npx playwright test --config playwright.smoke.config.ts
// or via the release-smoke GitHub Actions workflow.

import { expect, test } from "@playwright/test";

const email = process.env.SMOKE_EMAIL ?? "";
const password = process.env.SMOKE_PASSWORD ?? "";

test.beforeAll(() => {
  if (!email || !password) {
    throw new Error(
      "SMOKE_EMAIL and SMOKE_PASSWORD must be set to run the release smoke suite.",
    );
  }
});

test("sign in and verify backend health + browse renders real data", async ({
  page,
}) => {
  // 1. App redirects an unauthenticated user to login.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  // 2. Sign in with real Supabase credentials.
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();

  // 3. Successful login lands on Browse (the default route).
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });

  // 4. The health indicator must show the backend is reachable.
  //    HealthDot renders a green dot (title "API healthy") when /healthz
  //    returns { status: "ok" }. A red dot means the backend is down.
  const healthDot = page.locator('[title="API healthy"]');
  await expect(healthDot).toBeVisible({ timeout: 10_000 });

  // 5. Browse must render at least one entity from the live API.
  //    We don't assert on specific names — data changes over time.
  const firstLink = page.getByRole("link").first();
  await expect(firstLink).toBeVisible({ timeout: 10_000 });

  // Final screenshot is always captured via playwright.smoke.config.ts
  // (screenshot: "on") and uploaded as a workflow artifact.
});
