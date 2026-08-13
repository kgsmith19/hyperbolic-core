// Shared e2e fixture helpers: mock the platform IdP's token endpoint (both
// grant types) so the REAL login form's signInWithPassword() call
// (packages/platform-client, ADR-03's one real entry point) succeeds
// against a fixture identity -- no real IdP involved, no real credential.
// Mirrors packages/platform-client/tests/platform-client.test.ts's own
// fixture shape.
import type { Page } from "@playwright/test";

export const FIXTURE_EMAIL = "operator@example.invalid";
export const FIXTURE_PASSWORD = "correct horse battery staple";
export const FIXTURE_USER_ID = "00000000-0000-4000-8000-000000000099";
export const FIXTURE_ACCESS_TOKEN = "fixture.e2e.access.token";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function fixtureSignInBody(expiresAt: number) {
  return {
    access_token: FIXTURE_ACCESS_TOKEN,
    token_type: "bearer",
    expires_in: expiresAt - nowSeconds(),
    expires_at: expiresAt,
    refresh_token: "fixture-e2e-refresh-token",
    user: {
      id: FIXTURE_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: FIXTURE_EMAIL,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

/**
 * Mocks BOTH Supabase Auth token grant types (`grant_type=password`, the
 * initial sign-in, AND `grant_type=refresh_token`, which supabase-js's own
 * `autoRefreshToken: true` background timer can fire on its own schedule)
 * against the SAME fixture identity. Matching both is deliberate, not just
 * the one the test triggers directly: `@supabase/supabase-js`'s auto-refresh
 * timer can attempt a refresh in the background at a time this spec does not
 * control, and if that unmocked request fell through to the real network it
 * would either hang or -- worse -- spuriously succeed/fail and desync the
 * test from what it thinks the browser's session state is.
 *
 * The response is computed fresh on every matched request (not once at call
 * time), so `expiresInSeconds` stays relative to "now" for every grant,
 * including any early background refresh.
 */
export async function mockAuth(page: Page, expiresInSeconds = 3600): Promise<void> {
  await page.route("**/auth/v1/token**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureSignInBody(nowSeconds() + expiresInSeconds)),
    });
  });
}

/**
 * Simulates "the IdP is unreachable" (SH-6): every remaining call to the
 * Supabase Auth API -- most importantly the refresh-token grant a stale
 * cached session attempts -- is aborted at the network layer, the same
 * failure shape a real DNS/connection failure produces for `fetch()`.
 *
 * Registered AFTER `mockAuth()`, this takes precedence for every request
 * from this point on: Playwright checks the most-recently-registered
 * matching route first, and this handler never calls `route.fallback()`, so
 * it fully owns every `/auth/v1/*` request going forward regardless of
 * `mockAuth()`'s earlier, narrower registration.
 */
export async function blockIdp(page: Page): Promise<void> {
  await page.route("**/auth/v1/**", (route) => route.abort("connectionfailed"));
}

export async function fillAndSubmitLogin(
  page: Page,
  email: string = FIXTURE_EMAIL,
  password: string = FIXTURE_PASSWORD
): Promise<void> {
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
}
