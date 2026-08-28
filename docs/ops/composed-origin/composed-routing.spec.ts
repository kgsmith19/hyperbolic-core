import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { rawHttpRequest } from "../test-support/raw-http-request.mjs";

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
    "/.env",
    "/.env/",
    "/.git/config",
    "/assets/does-not-exist",
    "/assets/does-not-exist.js",
    "/assets/does-not-exist.js/",
    "/life/assets/does-not-exist",
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

test("literal LifeOS boundaries mount the app while encoded boundaries fail closed", async ({
  page,
  request,
}) => {
  await installPlatformStubs(page);
  await seedSession(page);
  const canonical = await page.goto("/life/capture");
  expect(canonical?.status()).toBe(200);
  await expect(page).toHaveTitle("lifeos");
  await expect(page.locator('[data-app-data="lifeos-zone"]')).toBeVisible();

  for (const encodedPath of [
    "/%6cife/capture",
    "/%6cife",
    "/life%2Fcapture",
    "/life%2F",
    "/%6cife%2Fcapture",
    "/%2Flife/capture",
    "/shell/%2e%2e%2Flife%2Fcapture",
  ]) {
    const response = await request.get(encodedPath, { maxRedirects: 0 });
    expect(new URL(response.url()).pathname, encodedPath).toBe(encodedPath);
    expect(response.status(), encodedPath).toBe(404);
    const body = await response.text();
    expect(body, encodedPath).not.toContain("<title>hyperbolic-core</title>");
    expect(body, encodedPath).not.toContain("<title>lifeos</title>");
  }
});

test("reserved API and asset namespaces cannot traverse into either SPA fallback", async () => {
  for (const encodedPath of [
    "/%2Fapi/%2e%2e/settings",
    "//api/../settings",
    "/./assets/../settings",
    "/%2Flife/api/%2e%2e/capture",
    "//life/api/../capture",
    "/./life/assets/../capture",
    "/%2F%61pi/%2e%2e/settings",
    "//assets/../settings",
    "/./%2E/%61ssets/%2e%2E/settings",
    "/%2Flife/%61pi/%2e%2e/capture",
    "//%6Cife/assets/../capture",
    "/./life/%2E/%61pi/%2e%2e/capture",
    "/%2E/%6cife/%2F%61ssets/%2e%2E/capture",
    "/foo/../api/../settings",
    "/%66oo/%2e%2e/%61pi/%2e%2e/settings",
    "//foo/../api/../settings",
    "/%2Ffoo/%2e%2e/api/%2e%2e/settings",
    "/life/foo/../assets/../capture",
    "/life/%66oo/%2e%2e/%61ssets/%2e%2e/capture",
    "/alpha/beta/../../api/v1/../../settings",
    "/life/one/two/../../assets/v1/../../capture",
    "/%41pi/%2e%2e/settings",
    "/%41%50%49/%2e%2e/settings",
    "/%61%50i/%2e%2e/settings",
    "/%41ssets/../settings",
    "/%41%53%53%45%54%53/%2e%2e/settings",
    "/%61%53s%65%54%73/%2e%2e/settings",
    "/life/%41ssets/../capture",
    "/life/%41%73%53e%54%73/%2e%2e/capture",
    "/api/%2e%2e%2Fsettings",
    "/api//../settings",
    "/api/%2F%2e%2e%2Fsettings",
    "/%61pi//%2e%2e/settings",
    "/api/%2f/%2E.%2Fsettings",
    "/%61pi/%2e%2e%2Fsettings",
    "/api%2F%2e%2e%2Fsettings",
    "/assets/%2e%2e%2Fsettings",
    "/assets///../settings",
    "/%61ssets/%2F/%2e%2E/settings",
    "/%61ssets/%2e%2e%2Fsettings",
    "/assets%2F%2e%2e%2Fsettings",
    "/life/api/%2e%2e%2Fcapture",
    "/life/api//%2e%2e/capture",
    "/%6Cife/%61pi/%2f/%2E.%2Fcapture",
    "/life/%61pi/%2e%2e%2Fcapture",
    "/life/api%2F%2e%2e%2Fcapture",
    "/life/assets/%2e%2e%2Fcapture",
    "/life/assets/%2F%2e%2E%2fcapture",
    "/%6cife/%61ssets///../capture",
    "/life/%61ssets/%2e%2e%2Fcapture",
    "/life/assets%2F%2e%2e%2Fcapture",
  ]) {
    const response = await rawHttpRequest(ORIGIN, encodedPath);
    expect(response.rawRequestTarget, encodedPath).toBe(encodedPath);
    expect([400, 404], encodedPath).toContain(response.status);
    expect(response.headers["content-type"] ?? "", encodedPath).not.toMatch(
      /^text\/html\b/,
    );
    const body = response.body;
    expect(body, encodedPath).not.toContain("<title>hyperbolic-core</title>");
    expect(body, encodedPath).not.toContain("<title>lifeos</title>");
  }
});

test("reserved-component traversal policy ignores lookalikes, queries, and canonical traffic", async ({
  request,
}) => {
  for (const shellPath of [
    "/lifefoo",
    "/docs/api/reference",
    "/settings?return=/api/../x",
    "/settings?return=/%41pi/../x",
  ]) {
    const response = await request.get(shellPath);
    expect(response.status(), shellPath).toBe(200);
    expect(await response.text(), shellPath).toContain(
      "<title>hyperbolic-core</title>",
    );
  }

  const encodedEntity = await request.get(
    "/life/entities/id%2Fwith%2Fslashes",
  );
  expect(encodedEntity.status()).toBe(200);
  expect(await encodedEntity.text()).toContain("<title>lifeos</title>");

  for (const apiPath of ["/api/healthz", "/api/brain/health", "/life/api/healthz"]) {
    await expectStubApiResponse(await request.get(apiPath), apiPath);
  }
});

test("an encoded traversal out of LifeOS remains Shell-owned", async ({ request }) => {
  const encodedPath = "/life%2F..%2Fsettings";
  const response = await request.get(encodedPath, { maxRedirects: 0 });
  expect(new URL(response.url()).pathname).toBe(encodedPath);
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toContain("<title>hyperbolic-core</title>");
  expect(body).not.toContain("<title>lifeos</title>");
});

test("an encoded dot traversal above the origin root is rejected before SPA fallback", async ({
  request,
}) => {
  const encodedPath = "/%2e%2e%2Flife%2Fcapture";
  const response = await request.get(encodedPath, { maxRedirects: 0 });
  expect(new URL(response.url()).pathname).toBe(encodedPath);
  expect(response.status()).toBe(400);
  const body = await response.text();
  expect(body).not.toContain("<title>hyperbolic-core</title>");
  expect(body).not.toContain("<title>lifeos</title>");
});

test("malformed percent request targets are rejected before either SPA fallback", async ({
  request,
}) => {
  for (const malformedPath of ["/%zzlife/capture", "/life/%2", "/life/%"]) {
    const response = await request.get(malformedPath, { maxRedirects: 0 });
    expect(new URL(response.url()).pathname, malformedPath).toBe(malformedPath);
    expect(response.status(), malformedPath).toBe(400);
    const body = await response.text();
    expect(body, malformedPath).not.toContain("<title>hyperbolic-core</title>");
    expect(body, malformedPath).not.toContain("<title>lifeos</title>");
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
