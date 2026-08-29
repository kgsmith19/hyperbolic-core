/**
 * T-E-001 — Hermetic browser acceptance proof for Prompt Organizer's
 * highest-value user flow: restore an already-issued session -> save prompt
 * -> independently read it back -> render/copy -> record usage/log_run ->
 * archive it.
 *
 * Authentication/authorization is deliberately split by oracle:
 * - this browser spec proves the real UI threads its stored bearer credential
 *   through every REST request and handles the critical browser lifecycle;
 * - backend/tests/contract.test.mjs proves the committed prompt.* grants/RLS
 *   with owner and stranger subjects against disposable PostgreSQL.
 *
 * No hosted Supabase credential or shared hosted state participates in this
 * required PR check. Live hosted-Supabase suites remain separate deployment
 * contract proofs.
 */
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

const TOKEN_STORAGE_KEY = "prompt-organizer-manual-check-token";
const REST_ROOT = "https://woltgcggxaehtuypkxqk.supabase.co/rest/v1";
const OWNER_SESSION = "hermetic-owner-session";
const RUN_ID = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const PROMPT_TITLE = `e2e-critical-flow-${RUN_ID}`;
const PROMPT_BODY = "Deploy {{REPO}} to production.";
const VARIABLE_VALUE = "toolbelt";
const EXPECTED_RENDERED = "Deploy toolbelt to production.";

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function parseBody(request) {
  const raw = request.postData();
  return raw ? JSON.parse(raw) : undefined;
}

async function installHermeticPromptApi(page, expectedToken = OWNER_SESSION) {
  const state = {
    prompts: new Map(),
    usage: [],
    logRuns: [],
    requests: [],
    unauthorized: 0,
    unexpected: [],
  };

  await page.route("**/rest/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const resource = url.pathname.split("/rest/v1/")[1] ?? "";
    const headers = request.headers();
    const authorization = headers.authorization ?? "";
    const record = {
      method: request.method(),
      resource,
      authorization,
      acceptProfile: headers["accept-profile"] ?? "",
      contentProfile: headers["content-profile"] ?? "",
    };
    state.requests.push(record);

    if (authorization !== `Bearer ${expectedToken}`) {
      state.unauthorized += 1;
      return json(route, 401, { message: "invalid hermetic session" });
    }

    if (request.method() === "GET" && resource === "prompt") {
      const titleFilter = url.searchParams.get("title");
      if (titleFilter?.startsWith("eq.")) {
        const title = titleFilter.slice(3);
        const rows = [...state.prompts.values()]
          .filter((prompt) => prompt.title === title)
          .map(({ title: savedTitle, body }) => ({ title: savedTitle, body }));
        return json(route, 200, rows);
      }

      const activeFilter = url.searchParams.get("is_active");
      const rows = [...state.prompts.values()]
        .filter((prompt) => {
          if (activeFilter === "eq.true") return prompt.is_active;
          if (activeFilter === "eq.false") return !prompt.is_active;
          return true;
        })
        .map((prompt) => ({
          id: prompt.id,
          title: prompt.title,
          body: prompt.body,
          is_active: prompt.is_active,
          tag: [],
          prompt_version: [{ version_no: prompt.version_no }],
          configuration: [],
        }));
      return json(route, 200, rows);
    }

    if (request.method() === "POST" && resource === "prompt") {
      const body = parseBody(request);
      const prompt = {
        id: `prompt-${state.prompts.size + 1}`,
        title: body.title,
        body: body.body,
        is_active: true,
        version_no: 1,
      };
      state.prompts.set(prompt.id, prompt);
      return json(route, 201, [prompt]);
    }

    if (request.method() === "PATCH" && resource === "prompt") {
      const idFilter = url.searchParams.get("id") ?? "";
      const id = idFilter.startsWith("eq.") ? idFilter.slice(3) : idFilter;
      const prompt = state.prompts.get(id);
      if (!prompt) return json(route, 404, { message: "fixture prompt not found" });
      Object.assign(prompt, parseBody(request));
      return json(route, 200, [prompt]);
    }

    if (request.method() === "POST" && resource === "usage") {
      const body = parseBody(request);
      state.usage.push(body);
      return json(route, 201, [body]);
    }

    if (request.method() === "POST" && resource === "rpc/log_run") {
      const body = parseBody(request);
      state.logRuns.push({
        ...body,
        acceptProfile: record.acceptProfile,
        contentProfile: record.contentProfile,
      });
      return json(route, 200, null);
    }

    state.unexpected.push(`${request.method()} ${resource}`);
    return json(route, 500, { message: `unexpected hermetic API request: ${request.method()} ${resource}` });
  });

  return state;
}

test("critical_prompt_flow__unlock_save_read_render_copy_archive__T_E_001", async ({ page, context }) => {
  const state = await installHermeticPromptApi(page);
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8812";

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(
    ([storageKey, token]) => sessionStorage.setItem(storageKey, token),
    [TOKEN_STORAGE_KEY, OWNER_SESSION],
  );

  await page.goto(baseUrl);
  await expect(page.locator("h1")).toContainText("Prompt Organizer");
  await expect(page.locator("#token-form")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#app")).toBeVisible({ timeout: 15_000 });

  await page.fill("#title", PROMPT_TITLE);
  await page.fill("#body", PROMPT_BODY);
  await page.click('#save-form button[type="submit"]');

  const saveError = page.locator("#save-error");
  const promptSummary = page.locator("#prompt-list summary", { hasText: PROMPT_TITLE });
  await expect(promptSummary).toBeVisible({ timeout: 10_000 });
  await expect(saveError, "the save POST must not have been rejected").toHaveText("");

  // Independent readback through browser fetch: this does not trust the DOM's
  // optimistic copy. It exercises a second request against fixture persistence
  // and proves the same bearer credential is required at that boundary.
  const persisted = await page.evaluate(
    async ({ restRoot, token, title }) => {
      const response = await fetch(
        `${restRoot}/prompt?title=eq.${encodeURIComponent(title)}&select=title,body`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return { status: response.status, json: await response.json() };
    },
    { restRoot: REST_ROOT, token: OWNER_SESSION, title: PROMPT_TITLE },
  );
  expect(persisted.status).toBe(200);
  expect(persisted.json).toEqual([{ title: PROMPT_TITLE, body: PROMPT_BODY }]);

  await promptSummary.click();
  const promptDetails = page.locator("#prompt-list details", {
    has: page.locator("summary", { hasText: PROMPT_TITLE }),
  });
  const repoInput = promptDetails.getByRole("textbox", { name: "REPO", exact: true });
  await expect(repoInput).toBeVisible({ timeout: 5_000 });
  await repoInput.fill(VARIABLE_VALUE);
  await promptDetails.getByRole("button", { name: "Copy rendered text" }).click();
  await expect(promptDetails.locator("p", { hasText: "Copied!" })).toBeVisible({ timeout: 8_000 });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(EXPECTED_RENDERED);

  await expect.poll(() => state.usage.length, { timeout: 5_000 }).toBe(1);
  await expect.poll(() => state.logRuns.length, { timeout: 5_000 }).toBe(1);
  expect(state.usage[0]).toEqual({ prompt_id: "prompt-1", version_no: 1 });
  expect(state.logRuns[0].p_app_id).toBe("prompt-organizer");
  expect(state.logRuns[0].p_kind).toBe("render");
  expect(state.logRuns[0].p_wall_clock_ms).toEqual(expect.any(Number));
  expect(state.logRuns[0].acceptProfile).toBe("core");
  expect(state.logRuns[0].contentProfile).toBe("core");

  await page.screenshot({
    path: `test-results/critical-flow-${RUN_ID}.png`,
    fullPage: false,
  });

  await promptDetails.getByRole("button", { name: "Archive", exact: true }).click();
  await expect.poll(() => state.prompts.get("prompt-1")?.is_active).toBe(false);
  await expect(page.locator("#prompt-list summary", { hasText: PROMPT_TITLE })).toHaveCount(0);

  expect(state.unexpected).toEqual([]);
  expect(state.unauthorized).toBe(0);
  expect(state.requests.length).toBeGreaterThanOrEqual(6);
  expect(state.requests.every((request) => request.authorization === `Bearer ${OWNER_SESSION}`)).toBe(true);
});

test("stored_wrong_session_fails_closed_before_the_app_unlocks__T_E_002", async ({ page }) => {
  const state = await installHermeticPromptApi(page);
  await page.addInitScript(
    ([storageKey, token]) => sessionStorage.setItem(storageKey, token),
    [TOKEN_STORAGE_KEY, "wrong-session"],
  );

  await page.goto(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8812");
  await expect(page.locator("#token-form")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#app")).toBeHidden();
  expect(state.unauthorized).toBe(1);
  expect(state.prompts.size).toBe(0);
});
