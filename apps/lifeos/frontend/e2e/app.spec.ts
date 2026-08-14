// e2e with a fake session + intercepted network: deterministic, no secrets.
// The API and Supabase never receive real traffic here.
//
// m2-08 (docs/planning/issues/m2-08-feat-lifeos-shell-integration.md)
// changed three things every test below now depends on:
//  1. Base path: the app is served at "/life/*", not "/*"
//     (vite.config.ts's `base`, App.tsx's router `basename`) -- every
//     `page.goto()` call spells the "/life" prefix out; `baseURL`'s own
//     path segment is NOT honored for a "/"-leading `goto()` argument
//     (playwright.config.ts's own comment).
//  2. API base: src/api/client.ts now defaults to the same-origin relative
//     "/life/api" (the one-origin route table's own prefix) rather than an
//     absolute `VITE_API_URL` -- playwright.config.ts deliberately leaves
//     that var unset for this suite, so these mocks intercept the REAL
//     default path this app requests in production, not a stand-in origin.
//  3. Session source: there is no local login form anymore. `signIn()`
//     below seeds the same-origin `localStorage` key `@supabase/supabase-js`
//     itself would have written after a real sign-in against
//     `VITE_SUPABASE_URL=https://test.supabase.co` (playwright.config.ts's
//     `webServer.env`) -- `src/lib/session.ts`'s `platformClient` reads
//     that key on `getSession()`, the same mechanism
//     apps/shell/e2e/support/auth.ts's `mockAuth()` exercises for the
//     Shell's own login form, just seeded directly here since this zone has
//     no form of its own to submit through (LO-2b).
import { expect, test, type Page } from "@playwright/test";

const API = "/life/api";

const ENTITY = {
  id: "e1",
  name: "Morning run",
  attributes: { kind: "run", duration_min: 32 },
  created_at: "2026-07-26T07:30:00Z",
  updated_at: "2026-07-26T07:30:00Z",
};

async function signIn(page: Page) {
  await page.addInitScript(() => {
    const session = {
      access_token: "fake-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "fake-refresh",
      user: { id: "owner", aud: "authenticated", email: "kyle@example.com" },
    };
    window.localStorage.setItem("sb-test-auth-token", JSON.stringify(session));
  });
  await page.route("**/auth/v1/**", (route) => route.fulfill({ json: {} }));
  // platform-client's enforceOwner() calls core.is_platform_owner() via a
  // raw fetch on every session resolution path (getSession,
  // onAuthStateChange -- packages/platform-client/src/index.ts's
  // isOwnerSession()), the same mock apps/shell/e2e/support/auth.ts's own
  // mockAuth() already has to carry for every Shell spec. Without it here
  // too, that fetch reaches nothing this sandbox can answer and the owner
  // check fails closed -- every page below renders "signed out" instead
  // of the platform chrome, regardless of the session seeded above.
  // PostgREST returns a scalar RPC's result as a bare JSON literal, not a
  // wrapper object, matching isOwnerSession's `data === true` check.
  await page.route("**/rest/v1/rpc/is_platform_owner**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "true" }),
  );
}

async function mockApi(page: Page) {
  await page.route(`**${API}/healthz`, (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route(`**${API}/types`, (route) =>
    route.fulfill({
      json: [
        {
          name: "workout",
          domain: "health",
          json_schema: {
            type: "object",
            properties: {
              kind: { type: "string" },
              duration_min: { type: "number" },
            },
            required: ["kind"],
          },
        },
      ],
    }),
  );
  await page.route(`**${API}/search**`, (route) =>
    route.fulfill({ json: [ENTITY] }),
  );
  await page.route(`**${API}/entities/e1`, (route) =>
    route.fulfill({
      json: { entity: ENTITY, types: ["workout"], edges_out: [], edges_in: [] },
    }),
  );
  await page.route(`**${API}/entities/e1/history`, (route) =>
    route.fulfill({
      json: [
        {
          id: "ev1",
          entity_id: "e1",
          event_type: "entity.created",
          payload: {},
          valid_time: "2026-07-26T07:30:00Z",
          recorded_at: "2026-07-26T07:30:00Z",
          actor: "kyle",
        },
      ],
    }),
  );
}

test("redirects toward the Shell's login when signed out", async ({ page }) => {
  // SH-2/LO-2 (this issue): a signed-out deep link is a REAL browser
  // navigation to the Shell's "/login" (root-relative -- the Shell owns
  // "/", ADR-02's one origin), not a client-side route inside this zone's
  // own router (it no longer has a "/login" route at all). This sandbox
  // runs only the LifeOS dev server, with no Shell listening at "/", so the
  // resulting page 404s here -- what this test can and does prove is the
  // one thing that is actually this zone's responsibility: the gate fires
  // and the browser is actually sent to "/login" carrying the originally
  // requested "/life" path, not that the Shell's login page itself renders
  // (apps/shell/e2e/auth-gate.spec.ts already covers that page, for the
  // Shell's own routes).
  await page.goto("/life/capture");
  await page.waitForURL((url) => url.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("return")).toBe("/life/capture");
});

test("browse -> entity detail round trip", async ({ page }) => {
  await signIn(page);
  await mockApi(page);
  await page.goto("/life/");
  await expect(page.getByTestId("platform-nav")).toBeVisible();
  await page.getByRole("link", { name: /morning run/i }).click();
  await expect(
    page.getByRole("heading", { name: "Morning run" }),
  ).toBeVisible();
  await expect(page.getByText("entity.created")).toBeVisible();
});

test("chat streams an answer with citation chips", async ({ page }) => {
  await signIn(page);
  await mockApi(page);
  await page.route(`**${API}/chat`, (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body:
        [
          'event: tool\ndata: {"name": "find"}',
          'event: text\ndata: {"delta": "Two workouts."}',
          'event: done\ndata: {"citations": {"entity_ids": ["e1"], "event_ids": ["ev1"], "methods": ["kernel.find"]}, "latency": {"model_ms": 1, "tool_ms": 1, "total_ms": 2}, "model": "test", "stop_reason": "end_turn"}',
        ].join("\n\n") + "\n\n",
    }),
  );
  await page.goto("/life/chat");
  await page.getByPlaceholder(/ask about your data/i).fill("workouts?");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByText("Two workouts.")).toBeVisible();
  // react-router renders every generated href WITH the router `basename`
  // prefix (App.tsx's `basename="/life"`) even though the page's own
  // `<Link to="/entities/e1">` never spells that prefix out itself.
  await expect(page.getByRole("link", { name: "e1" })).toHaveAttribute(
    "href",
    "/life/entities/e1",
  );
});

// The briefing cites entity ids and stores no text (ADR 014), so the page is
// only correct if it resolves each id through /entities/{id} at read time.
// Dated in the past on purpose: the backend keys briefings in its own timezone,
// so the page must render the briefing that exists, labelled with its own date,
// rather than look for one keyed to the browser's today.
const BRIEFING = {
  id: "b1",
  name: null,
  attributes: {
    briefing_key: "2020-01-03",
    date: "2020-01-03",
    focus_intention_ids: ["i1"],
    appointment_ids: ["a2", "a1"], // deliberately not in start order
    open_review_ids: ["r1"], // an old-composition leftover: must be ignored
    gate: { weeks: [5, 5, 4, 5], met: false }, // the Monday (weekly) edition
  },
  created_at: "2026-07-29T06:00:00Z",
  updated_at: "2026-07-29T06:00:00Z",
};

const CITED: Record<string, { name: string | null; attributes: object }> = {
  a1: { name: "Standup", attributes: { starts_at: "2026-07-29T08:00:00Z" } },
  a2: { name: "Dentist", attributes: { starts_at: "2026-07-29T15:00:00Z" } },
  i1: {
    name: null,
    attributes: {
      title: "Strength training",
      kind: "habit_quota",
      status: "active",
      focus: true,
      floor: "one set of squats at home",
      next_action: "load the Monday plan",
    },
  },
};

test("tomorrow resolves the briefing's ids into a readable cockpit", async ({
  page,
}) => {
  await signIn(page);
  await page.route(`**${API}/healthz`, (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  // Match filters the way the server does, so asking for a briefing_key that
  // was never written returns nothing instead of today's briefing.
  await page.route(`**${API}/search**`, (route) => {
    const filters = new URL(route.request().url()).searchParams.get("filters");
    const key = filters
      ? (JSON.parse(filters) as { briefing_key?: string }).briefing_key
      : undefined;
    const match = !key || key === BRIEFING.attributes.briefing_key;
    return route.fulfill({ json: match ? [BRIEFING] : [] });
  });
  await page.route(`**${API}/entities/*`, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const cited = CITED[id];
    if (!cited) return route.fulfill({ status: 404, json: { detail: "gone" } });
    return route.fulfill({
      json: {
        entity: {
          id,
          ...cited,
          created_at: "2026-07-29T06:00:00Z",
          updated_at: "2026-07-29T06:00:00Z",
        },
        types: ["thing"],
        edges_out: [],
        edges_in: [],
      },
    });
  });

  await page.goto("/life/tomorrow");
  await expect(page.getByText("Briefing for 2020-01-03")).toBeVisible();
  // Scoped to the zone's own content, not the whole page: Chrome's own
  // NavRail (packages/ui/src/chrome/nav-rail.tsx) also renders a plain
  // "ul > li" list (one "li" per zone entry), which an unscoped locator
  // here would match FIRST and shadow this page's own list.
  const rows = page.locator('[data-app-data="lifeos-zone"] ul > li');
  await expect(rows.nth(0)).toContainText("Strength training"); // focus leads
  await expect(rows.nth(0)).toContainText("Floor: one set of squats at home");
  await expect(rows.nth(1)).toContainText("Standup");
  await expect(rows.nth(2)).toContainText("Dentist");
  await expect(
    page.getByText("Open — check-in days per week: 5 · 5 · 4 · 5"),
  ).toBeVisible();
  // the old composition's keys resolve to nothing rendered, not a section
  await expect(
    page.getByRole("heading", { name: /needs your decision/i }),
  ).toHaveCount(0);
});

// ADR 018: the listing renders a draft's body only while a proposal is
// "proposed" — once decided, the letter comes only from the receipt-gated
// GET .../draft. The mock below enforces that shape itself (state flips after
// approval, and the list route never serves a body for the approved proposal)
// so the test would fail if the page ever fell back to a stale `body`.
test("approving a proposal reveals the draft through the gated endpoint", async ({
  page,
}) => {
  await signIn(page);
  await page.route(`**${API}/healthz`, (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  let approved = false;
  await page.route(`**${API}/action-proposals`, (route) =>
    route.fulfill({
      json: [
        approved
          ? {
              proposal_id: "p1",
              kind: "dispute_draft",
              state: "approved",
              subject_ids: ["bill1"],
              points: [],
              unresolved_count: 1,
              authority_receipt_id: "auth1",
              body: null,
              draft_digest: null,
            }
          : {
              proposal_id: "p1",
              kind: "dispute_draft",
              state: "proposed",
              subject_ids: ["bill1"],
              points: [],
              unresolved_count: 1,
              body: "Dear Acme Billing, I am disputing charge #4471.",
              draft_digest: "digest-1",
            },
      ],
    }),
  );
  let approveBody: unknown;
  await page.route(`**${API}/action-proposals/p1/approve`, async (route) => {
    approveBody = route.request().postDataJSON();
    approved = true;
    await route.fulfill({
      json: {
        proposal_id: "p1",
        state: "approved",
        authority_receipt_id: "auth1",
        expires_at: "2026-08-15T00:00:00Z",
      },
    });
  });
  await page.route(`**${API}/action-proposals/p1/draft`, (route) =>
    route.fulfill({
      json: {
        proposal_id: "p1",
        authority_receipt_id: "auth1",
        channel: "on_screen",
        permits: ["display_draft"],
        expires_at: "2026-08-15T00:00:00Z",
        body: "Dear Acme Billing, I am disputing charge #4471.",
      },
    }),
  );

  await page.goto("/life/approvals");
  await expect(page.getByText(/disputing charge #4471/)).toBeVisible();
  await expect(page.getByRole("link", { name: "bill1" })).toHaveAttribute(
    "href",
    "/life/entities/bill1",
  );
  await page.getByRole("button", { name: /approve/i }).click();

  await expect(page.getByText("approved")).toBeVisible();
  // Re-rendered through GET .../draft, not carried over from the listing.
  await expect(page.getByText(/disputing charge #4471/)).toBeVisible();
  await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
  expect(approveBody).toEqual({ draft_digest: "digest-1" });
});

test("capture posts schema-driven attributes", async ({ page }) => {
  await signIn(page);
  await mockApi(page);
  let captured: unknown;
  await page.route(`**${API}/capture`, async (route) => {
    captured = route.request().postDataJSON();
    await route.fulfill({ json: { entity_id: "e1", resolution: "new" } });
  });
  await page.goto("/life/capture");
  await page.locator("select").selectOption("workout");
  await page.getByLabel(/kind/i).fill("run");
  await page.getByLabel(/duration_min/i).fill("32");
  await page.getByRole("button", { name: /capture/i }).click();
  await expect(
    page.getByRole("heading", { name: "Morning run" }),
  ).toBeVisible();
  expect(captured).toEqual({
    type_name: "workout",
    attributes: { kind: "run", duration_min: 32 },
  });
});
