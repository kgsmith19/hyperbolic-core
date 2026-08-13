import { test, expect } from "@playwright/test";
import { mockAuth, fillAndSubmitLogin, FIXTURE_USER_ID } from "./support/auth";

// SH-2a / SH-2b (docs/planning/05-a-hyperbolic-core.md section 12): every
// prefix in the section 4 route map gates behind login for an unauthenticated
// browser, rendering zero data nodes, and a deep link returns to the exact
// requested path after a successful login.
const GATED_ROUTES = ["/", "/acc", "/tools", "/prompts", "/ideas", "/settings"] as const;

test.describe("Unauthenticated deep links (SH-2a): login flow only, zero data nodes", () => {
  for (const route of GATED_ROUTES) {
    test(`${route}: renders the login form and zero [data-app-data] nodes, no chrome`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByTestId("login-form")).toBeVisible();
      await expect(page.locator("[data-app-data]")).toHaveCount(0);
      // Not just "no data nodes" -- the chrome itself (which only renders
      // for an authenticated operator, SH-1a) must also be absent.
      await expect(page.getByTestId("platform-nav")).toHaveCount(0);
    });
  }

  test("an unrecognized path also gates behind login rather than falling through to the 404 page", async ({
    page,
  }) => {
    await page.goto("/this-route-does-not-exist");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId("login-form")).toBeVisible();
    await expect(page.locator("[data-app-data]")).toHaveCount(0);
  });
});

test.describe("Deep-link return-after-login (SH-2b)", () => {
  for (const route of ["/tools", "/prompts", "/ideas", "/acc", "/settings"] as const) {
    test(`logging in from a gated ${route} deep link lands back on ${route}, not /`, async ({ page }) => {
      await mockAuth(page);
      await page.goto(route);
      await expect(page).toHaveURL(/\/login\?return=/);

      await fillAndSubmitLogin(page);

      await page.waitForURL((url) => url.pathname === route);
      expect(new URL(page.url()).pathname).toBe(route);
      await expect(page.getByTestId("platform-nav")).toBeVisible();
    });
  }

  test("logging in from the bare / deep link lands on /, and chrome renders with the real session", async ({
    page,
  }) => {
    await mockAuth(page);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await fillAndSubmitLogin(page);
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByTestId("platform-nav")).toBeVisible();
    // Session menu (packages/ui/src/chrome/topbar.tsx) renders the userId
    // once a REAL (non-null) session is in effect -- proves the session
    // returned by signInWithPassword actually propagated into Chrome.
    await expect(page.getByText(FIXTURE_USER_ID)).toBeVisible();
  });

  test("a bogus ?return= target never escapes the origin (open-redirect guard)", async ({ page }) => {
    await mockAuth(page);
    await page.goto("/login?return=" + encodeURIComponent("https://evil.example.com"));
    await fillAndSubmitLogin(page);
    // Falls back to "/" rather than honoring the attacker-supplied target.
    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).pathname).toBe("/");
  });
});

test.describe("Wrong credentials", () => {
  test("a rejected sign-in shows an error and never leaves the login route or renders data nodes", async ({
    page,
  }) => {
    await page.route("**/auth/v1/token?grant_type=password*", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }),
      })
    );
    await page.goto("/tools");
    await fillAndSubmitLogin(page);
    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("[data-app-data]")).toHaveCount(0);
    await expect(page.getByTestId("platform-nav")).toHaveCount(0);
  });
});
