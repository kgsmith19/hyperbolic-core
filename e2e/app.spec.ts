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
