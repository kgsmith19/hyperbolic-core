import { test, expect } from "@playwright/test";
import { fillAndSubmitLogin, FIXTURE_ACCESS_TOKEN, FIXTURE_USER_ID } from "./support/auth";

// SH-3 (docs/planning/05-a-hyperbolic-core.md section 12): "When the
// operator authenticates once at the Shell, one authenticated API call per
// composed app ... shall return 200 without a second login."
//
// Judgment call, flagged explicitly rather than silently guessed (mirrors
// this issue's own allowance for the SH-4 curl check): Shell owns no
// composed-app API within THIS issue's file scope yet. LifeOS zone wiring
// is m2-08; the PostgREST-backed tools/prompts/ideas calls are each a later
// issue (05-a section 4's own "content" column). Building a fake endpoint
// dressed up as a real LifeOS/PostgREST integration here would be exactly
// the kind of fabrication this session's testing mandate warns against.
//
// What this spec proves instead is the CLIENT-LEVEL guarantee SH-3 actually
// depends on: one `getSession()`-backed login (this file's real login UI,
// exercised exactly as an operator would) lets `platformClient.fetch` (the
// frozen AuthedFetch contract, docs/planning/05-a-hyperbolic-core.md section
// 6) attach the SAME bearer token to calls against several distinct
// same-origin app paths standing in for LifeOS's API and PostgREST (the
// real V1 topology per 05-a section 2 is ALSO one origin, so same-origin
// mock paths are the topologically faithful choice, not a shortcut around
// CORS) -- and that `signInWithPassword` fires exactly once throughout,
// however many "composed app" calls and zone navigations follow. Reached via
// `window.__hyperbolicPlatformClient`, a build-time e2e-only hook
// (VITE_E2E_HOOKS=1, see playwright.config.ts and src/lib/session.ts) that
// exposes the EXACT SAME platform-client singleton every Shell page already
// renders from, not a stand-in.
const MOCK_LIFEOS_API = "/e2e-mock/life/api/entities";
const MOCK_POSTGREST_TOOLS = "/e2e-mock/postgrest/tools";
const MOCK_POSTGREST_PROMPTS = "/e2e-mock/postgrest/prompts";

test("one login backs authenticated calls to every composed app, with no second sign-in", async ({ page }) => {
  let signInCalls = 0;
  await page.route("**/auth/v1/token?grant_type=password*", async (route) => {
    signInCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: FIXTURE_ACCESS_TOKEN,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: "fixture-e2e-refresh-token",
        user: {
          id: "00000000-0000-4000-8000-000000000099",
          aud: "authenticated",
          role: "authenticated",
          email: "operator@example.invalid",
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      }),
    });
  });

  // Finding #47 (P2, PR #8 review): platform-client's enforceOwner() calls
  // core.is_platform_owner() via a raw fetch on every session resolution
  // path, including this spec's real signInWithPassword() call below. This
  // spec deliberately does not reuse support/auth.ts's mockAuth() (it needs
  // its own signInCalls counter on the exact grant_type=password route), so
  // it must mock this RPC itself too -- see mockAuth's own comment for why
  // an unmocked call here targets a real, unreachable-from-this-fixture
  // Supabase host and never resolves.
  await page.route("**/rest/v1/rpc/is_platform_owner**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" });
  });

  const seenAuthHeaders: Record<string, string | undefined> = {};
  for (const [name, url] of Object.entries({
    lifeos: MOCK_LIFEOS_API,
    tools: MOCK_POSTGREST_TOOLS,
    prompts: MOCK_POSTGREST_PROMPTS,
  })) {
    await page.route(`**${url}`, async (route) => {
      seenAuthHeaders[name] = route.request().headers()["authorization"];
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
  }

  await page.goto("/tools");
  await expect(page).toHaveURL(/\/login/);
  await fillAndSubmitLogin(page);
  await page.waitForURL((url) => url.pathname === "/tools");
  expect(signInCalls).toBe(1);

  // The session propagated to the UI itself, not just to the underlying
  // client: the topbar's session menu (packages/ui/src/chrome/topbar.tsx)
  // renders the real fixture userId, proving useShellSession actually
  // threaded the signed-in session into Chrome's props -- not only into the
  // window.__hyperbolicPlatformClient hook the later fetch calls use below.
  await expect(page.getByText(FIXTURE_USER_ID)).toBeVisible();

  const statuses = await page.evaluate(
    async ([lifeos, tools, prompts]) => {
      const client = (window as unknown as { __hyperbolicPlatformClient: { fetch: typeof fetch } })
        .__hyperbolicPlatformClient;
      const responses = await Promise.all([client.fetch(lifeos), client.fetch(tools), client.fetch(prompts)]);
      return responses.map((response) => response.status);
    },
    [MOCK_LIFEOS_API, MOCK_POSTGREST_TOOLS, MOCK_POSTGREST_PROMPTS] as const
  );

  expect(statuses).toEqual([200, 200, 200]);
  // Still exactly one -- none of the three "composed app" calls, and no
  // page navigation since, triggered a second login.
  expect(signInCalls).toBe(1);
  for (const [name, header] of Object.entries(seenAuthHeaders)) {
    expect(header, `Authorization header for ${name}`).toBe(`Bearer ${FIXTURE_ACCESS_TOKEN}`);
  }

  // Navigating to a different Shell-served zone re-uses the SAME session --
  // no re-prompt, no second sign-in call.
  await page.goto("/prompts");
  await expect(page.getByTestId("platform-nav")).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
  expect(signInCalls).toBe(1);

  await page.goto("/settings");
  await expect(page.getByTestId("session-card")).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);
  expect(signInCalls).toBe(1);
});
