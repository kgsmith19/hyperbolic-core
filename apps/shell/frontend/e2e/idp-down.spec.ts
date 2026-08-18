import { test, expect } from "@playwright/test";
import { mockAuth, blockIdp, fillAndSubmitLogin } from "./support/auth";

// SH-6 (docs/planning/05-a-hyperbolic-core.md section 12): "While the IdP is
// unreachable, the Shell shall fail closed: no cached page shall issue an
// authenticated API call with an expired token." Verification per section
// 12: "network-block the IdP host, assert redirect to login."
//
// The scenario that actually exercises this: an operator has a PREVIOUSLY
// valid session cached in this browser whose token has now EXPIRED (the
// realistic "left a tab open past the token's lifetime" case), and the IdP
// is unreachable when the app next needs to refresh it. A browser that was
// simply never authenticated is already covered by auth-gate.spec.ts and
// isn't what SH-6 is about.
//
// This is a real, un-faked wait, not a shortcut: `@supabase/auth-js`'s own
// refresh path retries a blocked network call with exponential backoff for
// up to ~25-30s (GoTrueClient's AUTO_REFRESH_TICK_DURATION_MS = 30_000)
// before giving up and resolving fail-closed -- the identical mechanism
// packages/platform-client/tests/platform-client.test.ts proves at the
// client-contract level (using node:test's fake timers, unavailable inside
// a real Playwright-driven browser). Faking that here would mean patching
// timers inside the actual page's JS runtime, which risks corrupting
// React's own scheduling -- not worth the risk for one spec. See this
// issue's report.
//
// MANUAL-ONLY (Finding #80, PR #8 security review): this spec is no longer
// run by pr-verify.yml's PR-blocking Platform lane -- each test here pays a
// real ~30s wait (test.setTimeout(75_000) below), a repeated cost on every
// Shell/packages PR for a scenario that changes rarely. Run it via
// .github/workflows/shell-idp-down.yml (workflow_dispatch, manual) or
// locally (`npx playwright test e2e/idp-down.spec.ts` from apps/shell/,
// after `npm run build --workspace=packages/ui`). The FAST, deterministic
// half of the exact same UI contract this file proves -- fail-closed
// getSession() redirects to /login, no chrome, no data nodes, no real or
// fake-timer wait needed -- still runs on every PR:
// apps/shell/frontend/src/idp-down-contract.test.tsx (vitest).
test.describe("Fail-closed while the IdP is unreachable (SH-6)", () => {
  test("a cached session with an expired token redirects to login instead of rendering gated content, once the IdP is unreachable", async ({
    page,
  }) => {
    test.setTimeout(75_000);

    // Step 1: get a real, valid-at-sign-in cached session onto this page via
    // the actual login UI, but with a token that is ALREADY expired --
    // mirrors platform-client's own fixture for the identical scenario.
    await mockAuth(page, -60);
    await page.goto("/tools");
    await expect(page).toHaveURL(/\/login/);
    await fillAndSubmitLogin(page);
    await page.waitForURL((url) => url.pathname === "/tools");
    await expect(page.getByTestId("platform-nav")).toBeVisible();

    // Step 2: the IdP goes unreachable. Every further call to it -- above
    // all the refresh-token grant this expired session must attempt -- is
    // aborted at the network layer (a real fetch()-level connection
    // failure, not an HTTP error response).
    await blockIdp(page);

    // Step 3: reload the same "cached" page. getSession() must refuse to
    // hand back the unrefreshable, expired token, and the gate must fail
    // CLOSED: redirect to login, zero data nodes, no chrome.
    await page.reload();

    await page.waitForURL(/\/login/, { timeout: 60_000 });
    await expect(page.getByTestId("login-form")).toBeVisible();
    await expect(page.locator("[data-app-data]")).toHaveCount(0);
    await expect(page.getByTestId("platform-nav")).toHaveCount(0);
  });

  test("the platform client itself refuses to send an authenticated call once fail-closed (defense in depth on the frozen AuthedFetch contract)", async ({
    page,
  }) => {
    test.setTimeout(75_000);

    await mockAuth(page, -60);
    await page.goto("/tools");
    await fillAndSubmitLogin(page);
    await page.waitForURL((url) => url.pathname === "/tools");

    let mockHit = false;
    await page.route("**/e2e-mock/life/api/entities", async (route) => {
      mockHit = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await blockIdp(page);
    await page.reload();
    await page.waitForURL(/\/login/, { timeout: 60_000 });

    const outcome = await page.evaluate(async () => {
      const client = (window as unknown as { __hyperbolicPlatformClient: { fetch: typeof fetch } })
        .__hyperbolicPlatformClient;
      try {
        await client.fetch("/e2e-mock/life/api/entities");
        return "resolved";
      } catch {
        return "rejected";
      }
    });

    expect(outcome).toBe("rejected");
    expect(mockHit).toBe(false);
  });
});
