/**
 * T-E-002 — issue #249 regression: a superseded list fetch must not destroy a
 * just-saved prompt.
 *
 * Why this exists as its own spec rather than as an assertion inside
 * critical-flow.test.mjs: the defect needs the boot list GET to land in a
 * window a few milliseconds wide, just after the save POST. Against live
 * Supabase that window is a coincidence -- the failing CI run this Issue was
 * filed from (run 32201373860) hit it by 4.5ms, which is precisely why the
 * flake was rare and why the symptom looked like a rendering timeout. A test
 * that can only catch the bug by luck is not a regression test.
 *
 * So this spec owns the ordering instead of hoping for it. Every /rest/v1/
 * call is fulfilled by page.route, and the boot GET is held until the POST has
 * been fulfilled, then released. That makes the race deterministic and, as a
 * side effect, makes this the one browser spec here that needs no network, no
 * live project and no TOOLBELT_OWNER_TOKEN -- it exercises frontend/index.html
 * itself, which is where the defect lives.
 *
 * Oracle: once the stale snapshot has demonstrably been delivered (awaited at
 * the network layer -- the response cannot be asserted in the DOM, because
 * correctly discarding it is the whole point of the fix), a fresh render is
 * forced by typing into #search, which re-renders from whatever the client
 * currently holds in memory. The saved prompt must survive that render. On the
 * pre-fix client it does not: refreshList replaced allPrompts wholesale, so the
 * row is gone from state, the search finds nothing, and nothing re-fetches
 * afterwards to bring it back.
 *
 * Forcing that render is what stops the assertion passing vacuously -- without
 * it, a check made before the client processed the stale response would see
 * the row still on screen and report a false green.
 *
 * Run: PLAYWRIGHT_BASE_URL=http://localhost:8812 \
 *        npx playwright test --config frontend/playwright.config.mjs
 */
import { test, expect } from "@playwright/test";

const TOKEN_STORAGE_KEY = "prompt-organizer-manual-check-token";
const SAVED_TITLE = "e2e-list-overwrite-race-saved";
const SAVED_BODY = "Deploy {{REPO}} to production.";

// Rows the boot snapshot carries and the save response does not, so the
// snapshot is unmistakably a pre-insert view of the list.
const SNAPSHOT_ONLY_TITLES = [
  "e2e-list-overwrite-race-preexisting-1",
  "e2e-list-overwrite-race-preexisting-2",
];

const snapshotRow = (title) => ({
  id: `id-${title}`,
  title,
  body: "unrelated",
  is_active: true,
  tag: [],
  prompt_version: [{ version_no: 1 }],
  configuration: [],
});

// The offsets bracket the observed 4.5ms: releasing the stale snapshot right
// on top of the render, and far enough after it that any assertion polling
// would have seen the row first. Both must survive.
for (const releaseAfterMs of [0, 150]) {
  test(`saved prompt survives a boot snapshot landing ${releaseAfterMs}ms after the insert__T_E_002`, async ({
    page,
  }) => {
    let markPostFulfilled;
    const postFulfilled = new Promise((resolve) => {
      markPostFulfilled = resolve;
    });
    let markStaleGetLanded;
    const staleGetLanded = new Promise((resolve) => {
      markStaleGetLanded = resolve;
    });

    await page.route("**/rest/v1/**", async (route) => {
      const request = route.request();
      const url = request.url();

      // The boot list fetch: its snapshot is taken BEFORE the insert (it does
      // not contain the saved row) but it is delivered AFTER the POST.
      if (request.method() === "GET" && url.includes("/prompt?select=")) {
        await postFulfilled;
        await new Promise((resolve) => setTimeout(resolve, releaseAfterMs));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(SNAPSHOT_ONLY_TITLES.map(snapshotRow)),
        });
        markStaleGetLanded();
        return;
      }

      if (request.method() === "POST" && url.includes("/rest/v1/prompt")) {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify([
            { id: "id-saved", title: SAVED_TITLE, body: SAVED_BODY },
          ]),
        });
        markPostFulfilled();
        return;
      }

      // tag, usage and rpc/log_run are not under test here.
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    await page.addInitScript(
      ([storageKey, value]) => {
        sessionStorage.setItem(storageKey, value);
      },
      [TOKEN_STORAGE_KEY, "stubbed-session-token"]
    );

    await page.goto(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8812");
    await expect(page.locator("#app")).toBeVisible({ timeout: 15_000 });

    await page.fill("#title", SAVED_TITLE);
    await page.fill("#body", SAVED_BODY);
    await page.click('#save-form button[type="submit"]');

    const savedSummary = page.locator("#prompt-list summary", { hasText: SAVED_TITLE });
    await expect(savedSummary, "the save must render before the stale snapshot lands").toBeVisible({
      timeout: 15_000,
    });

    // The stale snapshot has now been delivered to the page.
    await staleGetLanded;

    // Force a render that necessarily happens AFTER it: typing into #search
    // re-renders the list from whatever the client holds in memory right now.
    // Without this the assertion could pass simply because the stale response
    // had not been processed yet.
    await page.fill("#search", SAVED_TITLE);

    await expect(
      page.locator("#prompt-list summary", { hasText: SAVED_TITLE }),
      "a list fetch that predates the insert must not destroy the saved prompt (issue #249)"
    ).toBeVisible();
    await expect(
      page.locator("#empty-state"),
      "the saved prompt must still be in client state, not just on screen"
    ).toBeHidden();
    await expect(page.locator("#save-error")).toHaveText("");
  });
}
