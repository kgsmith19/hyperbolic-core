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

const row = (id, title, isActive, body = "unused") => ({
  id,
  title,
  body,
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

  // ---- a LATER refreshList() call (the version-history restore button)
  // must also reuse the cache, not re-fetch archived rows again. This is
  // the exact gap the first version of this fix left open: archivedLoaded
  // gated the initial FETCH, but refreshList() itself still re-ran the
  // archived query on every subsequent call once that flag was true. ----
  await page.route("**/rest/v1/**", async (route) => {
    const request = route.request();
    const url = request.url();
    if (request.method() === "GET" && url.includes("/prompt_version?prompt_id=")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ version_no: 1, body: "an older draft", created_at: "2026-01-01T00:00:00Z" }]),
      });
    }
    if (request.method() === "PATCH" && url.includes("/prompt?id=")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    if (request.method() === "GET" && url.includes("/prompt?select=")) {
      const filter = new URL(url).searchParams.get("is_active");
      listFilters.push(filter);
      const body = filter === "eq.true" ? ACTIVE : filter === "eq.false" ? ARCHIVED : ACTIVE.concat(ARCHIVED);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  const activeSummary = page.locator("#prompt-list summary", { hasText: "e2e-bounded-active-1" });
  await activeSummary.click();
  const historyPanel = page.locator("#prompt-list details", { has: page.locator("summary", { hasText: "e2e-bounded-active-1" }) })
    .locator("details", { hasText: "Version history" });
  await historyPanel.locator("summary").click(); // expands -> fires the {once:true} toggle fetch
  await historyPanel.getByRole("button", { name: "Restore" }).click(); // PATCH, then refreshList()

  // .click() only dispatches the event; it does not wait for the async
  // click handler it triggers (PATCH, then refreshList()) to finish. Poll
  // for that handler's network activity to land rather than asserting
  // immediately against a listFilters snapshot that may predate it.
  await expect
    .poll(() => listFilters.length, {
      timeout: 10_000,
      message: "the restore's PATCH + refreshList() never completed",
    })
    .toBeGreaterThanOrEqual(3);
  await expect(page.locator("#prompt-list summary", { hasText: "e2e-bounded-active-1" })).toBeVisible();
  // A third request is expected -- refreshList() legitimately re-fetches
  // ACTIVE prompts on every call, by design. What must NOT happen is a
  // second "eq.false": that would mean archived rows were re-fetched
  // instead of reused from the cache.
  expect(
    listFilters,
    "a refreshList() triggered by restoring a version must re-fetch active prompts but reuse the cached archived rows, not re-fetch them (issue #261)"
  ).toEqual(["eq.true", "eq.false", "eq.true"]);
});
