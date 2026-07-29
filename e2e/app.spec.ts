// e2e with a fake session + intercepted network: deterministic, no secrets.
// The API and Supabase never receive real traffic here.
import { expect, test, type Page } from "@playwright/test";

// Scope every mock to the API host — bare '**/capture' patterns would also
// intercept the SPA's own page navigations.
const API = "https://lifeos-prod.taile48c9b.ts.net";

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
    window.localStorage.setItem(
      "sb-vhbzblllaohuljtareza-auth-token",
      JSON.stringify(session),
    );
  });
  await page.route("**/auth/v1/**", (route) => route.fulfill({ json: {} }));
}

async function mockApi(page: Page) {
  await page.route(`${API}/healthz`, (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route(`${API}/types`, (route) =>
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
  await page.route(`${API}/search**`, (route) =>
    route.fulfill({ json: [ENTITY] }),
  );
  await page.route(`${API}/entities/e1`, (route) =>
    route.fulfill({
      json: { entity: ENTITY, types: ["workout"], edges_out: [], edges_in: [] },
    }),
  );
  await page.route(`${API}/entities/e1/history`, (route) =>
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

test("redirects to login when signed out", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("browse -> entity detail round trip", async ({ page }) => {
  await signIn(page);
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("link", { name: /morning run/i }).click();
  await expect(
    page.getByRole("heading", { name: "Morning run" }),
  ).toBeVisible();
  await expect(page.getByText("entity.created")).toBeVisible();
});

test("chat streams an answer with citation chips", async ({ page }) => {
  await signIn(page);
  await mockApi(page);
  await page.route(`${API}/chat`, (route) =>
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
  await page.goto("/chat");
  await page.getByPlaceholder(/ask about your data/i).fill("workouts?");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByText("Two workouts.")).toBeVisible();
  await expect(page.getByRole("link", { name: "e1" })).toHaveAttribute(
    "href",
    "/entities/e1",
  );
});

// The briefing cites entity ids and stores no text (ADR 014), so the page is
// only correct if it resolves each id through /entities/{id} at read time.
const BRIEFING = {
  id: "b1",
  name: null,
  attributes: {
    briefing_key: "2026-07-29",
    date: "2026-07-29",
    appointment_ids: ["a2", "a1"], // deliberately not in start order
    open_review_ids: ["r1"],
    latest_checkin_id: "c1",
  },
  created_at: "2026-07-29T06:00:00Z",
  updated_at: "2026-07-29T06:00:00Z",
};

const CITED: Record<string, { name: string | null; attributes: object }> = {
  a1: { name: "Standup", attributes: { starts_at: "2026-07-29T08:00:00Z" } },
  a2: { name: "Dentist", attributes: { starts_at: "2026-07-29T15:00:00Z" } },
  r1: {
    name: null,
    attributes: {
      attendee_id: "att1",
      candidate_person_ids: ["p1"],
      reason: "ambiguous_email_match",
    },
  },
  c1: { name: null, attributes: { date: "2026-07-29", mood: 4 } },
};

test("tomorrow resolves the briefing's ids into a readable cockpit", async ({
  page,
}) => {
  await signIn(page);
  await page.route(`${API}/healthz`, (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
  await page.route(`${API}/search**`, (route) =>
    route.fulfill({ json: [BRIEFING] }),
  );
  await page.route(`${API}/entities/*`, (route) => {
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

  await page.goto("/tomorrow");
  const rows = page.locator("ul > li");
  await expect(rows.nth(0)).toContainText("Standup");
  await expect(rows.nth(1)).toContainText("Dentist");
  await expect(
    page.getByRole("heading", { name: /needs your decision/i }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "att1" })).toHaveAttribute(
    "href",
    "/entities/att1",
  );
  await expect(page.getByText("mood 4/5")).toBeVisible();
});

test("capture posts schema-driven attributes", async ({ page }) => {
  await signIn(page);
  await mockApi(page);
  let captured: unknown;
  await page.route(`${API}/capture`, async (route) => {
    captured = route.request().postDataJSON();
    await route.fulfill({ json: { entity_id: "e1", resolution: "new" } });
  });
  await page.goto("/capture");
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
