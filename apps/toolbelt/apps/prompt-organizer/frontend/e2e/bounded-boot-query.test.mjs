/**
 * T-E-003 — issue #261 regression: the boot list fetch must not download the
 * owner's entire prompt history (active and archived alike) on every page
 * load, and "Show archived" must still work without paying that cost by
 * default.
 *
 * Root cause this pins down: refreshList()'s query carried no is_active
 * filter at all, so every load re-downloaded every prompt ever created,
 * archived included -- and nothing ever deletes an archived row (ADR-0002
 * soft-delete; no DELETE grant on prompt.prompt). Measured directly from
 * issue #249's own evidence: that boot GET took 364.5ms against an account
 * with only 9 rows, and every CI run of critical-flow.test.mjs adds one more
 * row that never goes away.
 *
 * Same technique as list-overwrite-race.test.mjs (#249): every /rest/v1/
 * call is stubbed via page.route, so this needs no live Supabase and no
 * TOOLBELT_OWNER_TOKEN. It exercises frontend/index.html itself, where the
 * query lives.
 *
 * Run: PLAYWRIGHT_BASE_URL=http://localhost:8812 \
 *        npx playwright test --config frontend/playwright.config.mjs bounded-boot-query
 */
import { test, expect } from "@playwright/test";

const TOKEN_STORAGE_KEY = "prompt-organizer-manual-check-token";

const row = (id, title, isActive) => ({
  id,
  title,
  body: "unused",
  is_active: isActive,
  tag: [],
  prompt_version: [{ version_no: 1 }],
  configuration: [],
});

test("boot fetches only active prompts, and Show archived loads archived rows exactly once per session__T_E_003", async ({
  page,
}) => {
  const ACTIVE = [row("a1", "e2e-bounded-active-1", true), row("a2", "e2e-bounded-active-2", true)];
  const ARCHIVED = [row("r1", "e2e-bounded-archived-1", false)];

  // Records the is_active filter of every list GET, in order -- the oracle
  // for "bounded by default, opt-in once for archived, never re-fetched".
  const listFilters = [];

  await page.route("**/rest/v1/**", async (route) => {
    const request = route.request();
    const url = request.url();
    if (request.method() === "GET" && url.includes("/prompt?select=")) {
      const filter = new URL(url).searchParams.get("is_active");
      listFilters.push(filter);
      const body = filter === "eq.true" ? ACTIVE : filter === "eq.false" ? ARCHIVED : ACTIVE.concat(ARCHIVED);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    // tag/usage/rpc/log_run and anything else are not under test here.
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.addInitScript(
    ([storageKey, value]) => sessionStorage.setItem(storageKey, value),
    [TOKEN_STORAGE_KEY, "stubbed-session-token"]
  );
  await page.goto(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8812");
  await expect(page.locator("#app")).toBeVisible({ timeout: 15_000 });

  // ---- boot must request active prompts only -- never the full history ----
  expect(listFilters, "boot must issue exactly one list request").toHaveLength(1);
  expect(
    listFilters[0],
    "the boot request must filter to active prompts only, not the whole account (issue #261)"
  ).toBe("eq.true");
  await expect(page.locator("#prompt-list summary", { hasText: "e2e-bounded-active-1" })).toBeVisible();
  await expect(page.locator("#prompt-list summary", { hasText: "e2e-bounded-archived-1" })).toHaveCount(
    0,
    "an archived row must not be present before Show archived is ever checked"
  );

  // ---- opting into "Show archived" must still work, fetching archived rows ----
  await page.locator("#show-archived").check();
  await expect(page.locator("#prompt-list summary", { hasText: "e2e-bounded-archived-1" })).toBeVisible();
  expect(listFilters, "checking Show archived must fetch archived rows, once").toEqual(["eq.true", "eq.false"]);

  // ---- re-toggling must not pay the archived cost again this session ----
  await page.locator("#show-archived").uncheck();
  await expect(page.locator("#prompt-list summary", { hasText: "e2e-bounded-archived-1" })).toHaveCount(0);
  await page.locator("#show-archived").check();
  await expect(page.locator("#prompt-list summary", { hasText: "e2e-bounded-archived-1" })).toBeVisible();
  expect(
    listFilters,
    "a second Show-archived toggle must reuse the already-loaded archived rows, not re-fetch"
  ).toEqual(["eq.true", "eq.false"]);
});
