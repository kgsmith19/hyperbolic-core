import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ORIGIN = "http://127.0.0.1:18080";
const SUPABASE_ORIGIN = "https://test.supabase.co";
const AUTH_STORAGE_KEY = "sb-test-auth-token";
const USER_ID = "00000000-0000-4000-8000-000000000347";
const repoRoot = path.resolve(import.meta.dirname, "../../..");

function fixtureSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: "fixture.composed.access.token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: "fixture-composed-refresh-token",
    user: {
      id: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: "operator@example.invalid",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-08-27T00:00:00.000Z",
    },
  };
}

async function installPlatformStubs(page: Page) {
  await page.route(`${SUPABASE_ORIGIN}/auth/v1/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureSession()),
    }),
  );
  await page.route(
    `${SUPABASE_ORIGIN}/rest/v1/rpc/is_platform_owner**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "true",
      }),
  );

  // App-local calls stay same-origin. Match the configured origin exactly so
  // this fixture cannot swallow an accidental request to another host.
  await page.route(`${ORIGIN}/life/api/types`, (route) =>
    route.fulfill({
      json: [
        {
          name: "workout",
          domain: "health",
          json_schema: {
            type: "object",
            properties: { kind: { type: "string" } },
            required: ["kind"],
          },
        },
      ],
    }),
  );
  await page.route(`${ORIGIN}/life/api/search**`, (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(`${ORIGIN}/life/api/healthz`, (route) =>
    route.fulfill({ json: { status: "ok" } }),
  );
}

async function seedSession(page: Page) {
  await page.addInitScript(
    ({ key, session }) =>
      window.localStorage.setItem(key, JSON.stringify(session)),
    { key: AUTH_STORAGE_KEY, session: fixtureSession() },
  );
}

function pathOf(url: string) {
  return new URL(url).pathname;
}

async function expectStubApiResponse(
  response: APIResponse,
  expectedPath: string,
) {
  expect(response.status(), expectedPath).toBe(404);
  expect(response.headers()["content-type"], expectedPath).toMatch(
    /^application\/json/,
  );
  expect(await response.json(), expectedPath).toEqual({
    error: "composed-origin-api-stub",
    path: expectedPath,
  });
}

test("signed-out LifeOS deep link crosses Shell login by document replacement and survives refresh", async ({
  page,
}) => {
  await installPlatformStubs(page);
  const documentPaths: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document")
      documentPaths.push(pathOf(request.url()));
  });

  const initial = await page.goto("/life/capture");
  expect(initial?.status()).toBe(200);
  await expect(page).toHaveURL(/\/login\?return=%2Flife%2Fcapture$/);
  await expect(page.getByTestId("login-form")).toBeVisible();
  const historyLengthAtLogin = await page.evaluate(() => window.history.length);
  await page.evaluate(() => {
    (
      window as unknown as { __composedDocumentMarker?: string }
    ).__composedDocumentMarker = "shell-login";
  });

  await page.getByTestId("login-email").fill("operator@example.invalid");
  await page.getByTestId("login-password").fill("correct horse battery staple");
  const returnDocument = page.waitForRequest(
    (request) =>
      request.resourceType() === "document" &&
      pathOf(request.url()) === "/life/capture",
  );
  await page.getByTestId("login-submit").click();
  await returnDocument;

  await expect(page).toHaveURL(/\/life\/capture$/);
  await expect(page).toHaveTitle("lifeos");
  await expect(page.locator('[data-app-data="lifeos-zone"]')).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __composedDocumentMarker?: string })
          .__composedDocumentMarker,
    ),
  ).toBeUndefined();
  const storedUser = await page.evaluate(
    (key) => JSON.parse(window.localStorage.getItem(key) ?? "null")?.user?.id,
    AUTH_STORAGE_KEY,
  );
  expect(storedUser).toBe(USER_ID);
  expect(await page.evaluate(() => window.history.length)).toBe(
    historyLengthAtLogin,
  );

  expect(documentPaths).toEqual(
    expect.arrayContaining(["/life/capture", "/login", "/life/capture"]),
  );
  const reloadDocument = page.waitForRequest(
    (request) =>
      request.resourceType() === "document" &&
      pathOf(request.url()) === "/life/capture",
  );
  await page.reload();
  await reloadDocument;
  await expect(page).toHaveTitle("lifeos");
  await expect(page.locator('[data-app-data="lifeos-zone"]')).toBeVisible();
});

test("Shell login document loads directly and after refresh", async ({
  page,
}) => {
  await installPlatformStubs(page);
  const response = await page.goto("/login");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("hyperbolic-core");
  await expect(page.getByTestId("login-form")).toBeVisible();
  const refreshed = await page.reload();
  expect(refreshed?.status()).toBe(200);
  await expect(page).toHaveTitle("hyperbolic-core");
  await expect(page.getByTestId("login-form")).toBeVisible();
});

test("signed-in Shell settings document loads directly and after refresh", async ({
  page,
}) => {
  await installPlatformStubs(page);
  await seedSession(page);
  const response = await page.goto("/settings");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page).toHaveTitle("hyperbolic-core");
  await expect(page.getByTestId("platform-nav")).toBeVisible();
  const refreshed = await page.reload();
  expect(refreshed?.status()).toBe(200);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page).toHaveTitle("hyperbolic-core");
  await expect(page.getByTestId("platform-nav")).toBeVisible();
});

test("LifeOS chat document loads directly and after refresh", async ({
  page,
}) => {
  await installPlatformStubs(page);
  await seedSession(page);
  const response = await page.goto("/life/chat");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle("lifeos");
  await expect(page.locator('[data-app-data="lifeos-zone"]')).toBeVisible();
  const refreshed = await page.reload();
  expect(refreshed?.status()).toBe(200);
  await expect(page).toHaveTitle("lifeos");
  await expect(page.locator('[data-app-data="lifeos-zone"]')).toBeVisible();
});

test("real assets are served as assets while missing assets remain 404", async ({
  request,
}) => {
  const shellIndex = readFileSync(
    path.join(repoRoot, "apps/shell/frontend/dist/index.html"),
    "utf8",
  );
  const lifeIndex = readFileSync(
    path.join(repoRoot, "apps/lifeos/frontend/dist/index.html"),
    "utf8",
  );
  const shellAsset = shellIndex.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  const lifeAsset = lifeIndex.match(/src="(\/life\/assets\/[^"]+\.js)"/)?.[1];
  expect(shellAsset).toBeTruthy();
  expect(lifeAsset).toBeTruthy();

  for (const asset of [shellAsset!, lifeAsset!]) {
    const response = await request.get(asset);
    expect(response.status(), asset).toBe(200);
    expect(response.headers()["content-type"], asset).toMatch(/javascript/);
    expect(await response.text()).not.toContain("<title>");
  }
  for (const missing of [
    "/assets/does-not-exist.js",
    "/assets/does-not-exist.js/",
    "/life/assets/does-not-exist.js",
    "/life/assets/does-not-exist.js/",
    `${shellAsset}/`,
    `${lifeAsset}/`,
  ]) {
    const response = await request.get(missing);
    expect(response.status(), missing).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("<title>hyperbolic-core</title>");
    expect(body).not.toContain("<title>lifeos</title>");
  }
});

test("API failures never fall through to either SPA document", async ({
  request,
}) => {
  for (const apiPath of [
    "/api/not-a-route",
    "/api/not-a-route.js/",
    "/api/brain/not-a-route",
    "/api/brain/not-a-route.css/",
    "/life/api/not-a-route",
    "/life/api/not-a-route.png/",
  ]) {
    const response = await request.get(apiPath);
    await expectStubApiResponse(response, apiPath);
  }

  for (const [bare, canonical] of [
    ["/api", "/api/"],
    ["/api/brain", "/api/brain/"],
    ["/life/api", "/life/api/"],
  ] as const) {
    const redirect = await request.get(bare, { maxRedirects: 0 });
    expect(redirect.status(), bare).toBe(308);
    const location = redirect.headers().location;
    expect(location, bare).toBeTruthy();
    expect(new URL(location, ORIGIN).pathname, bare).toBe(canonical);
    const redirectBody = await redirect.text();
    expect(redirectBody, bare).not.toContain("<title>hyperbolic-core</title>");
    expect(redirectBody, bare).not.toContain("<title>lifeos</title>");

    const followed = await request.get(bare);
    await expectStubApiResponse(followed, canonical);
  }
});

test("Shell Home launches the real LifeOS bundle with a document request", async ({
  page,
}) => {
  await installPlatformStubs(page);
  await seedSession(page);
  await page.goto("/");
  await expect(page).toHaveTitle("hyperbolic-core");
  await page.evaluate(() => {
    (
      window as unknown as { __composedDocumentMarker?: string }
    ).__composedDocumentMarker = "shell-home";
  });
  const lifeDocument = page.waitForRequest(
    (request) =>
      request.resourceType() === "document" &&
      pathOf(request.url()) === "/life/",
  );
  await page.locator('[data-testid="launcher-card"][data-zone="life"]').click();
  await lifeDocument;
  await expect(page).toHaveTitle("lifeos");
  await expect(page.locator('[data-app-data="lifeos-zone"]')).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __composedDocumentMarker?: string })
          .__composedDocumentMarker,
    ),
  ).toBeUndefined();
});

test("Shell-internal navigation stays in the same document", async ({
  page,
}) => {
  await installPlatformStubs(page);
  await seedSession(page);
  await page.goto("/");
  await expect(page).toHaveTitle("hyperbolic-core");
  await page.evaluate(() => {
    (
      window as unknown as { __composedDocumentMarker?: string }
    ).__composedDocumentMarker = "shell-home";
  });
  let sawToolsDocument = false;
  page.on("request", (request) => {
    if (
      request.resourceType() === "document" &&
      pathOf(request.url()) === "/tools"
    )
      sawToolsDocument = true;
  });
  await page
    .locator('[data-testid="launcher-card"][data-zone="tools"]')
    .click();
  await expect(page).toHaveURL(/\/tools$/);
  expect(sawToolsDocument).toBe(false);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __composedDocumentMarker?: string })
          .__composedDocumentMarker,
    ),
  ).toBe("shell-home");
  await expect(page.getByTestId("platform-nav")).toBeVisible();
});
