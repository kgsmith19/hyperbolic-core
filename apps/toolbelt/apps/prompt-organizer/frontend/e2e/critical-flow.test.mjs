/**
 * T-E-001 — Browser acceptance proof for the highest-value Prompt Organizer
 * user flow: unlock with a token → save prompt with variable → open render
 * panel → fill variable → copy rendered text → verify clipboard → cleanup.
 *
 * Traces to: AC-001 (FR-001 save), AC-001 (FR-007 render/copy), AC-001
 * (FR-010 variable fill) → Issue #18.
 *
 * Run:
 *   npx playwright test tests/e2e/critical-flow.test.mjs \
 *     --config playwright.config.mjs
 *
 * Env vars (all optional; defaults match the shared fixture accounts used by
 * the integration suite):
 *   PLAYWRIGHT_BASE_URL   — URL of the running app   (default: http://localhost:8812)
 *   USER_A_EMAIL          — fallback token source     (default: fixture user A)
 *   USER_A_PASSWORD       — fallback token source     (default: fixture user A)
 *   TOOLBELT_OWNER_TOKEN  — real owner session, see "Owner-credential
 *                           threading" below (default: unset)
 *
 * Owner-credential threading (toolbelt-ci.yml P1 finding): once prompt.* RLS
 * is pinned to the real owner (20260812180000_prompt_owner_pin.sql), a
 * fixture-A session gets a real Supabase access token but every subsequent
 * write this flow depends on (save, tag, usage-on-copy) is RLS-denied, so
 * the "happy path" this test exists to prove would silently stop proving it.
 * TOOLBELT_OWNER_TOKEN (a real owner access token, never a password --
 * docs/notes/2026-08-12-platform-idp-owner-setup.md step 3) takes priority
 * when set; a fixture-A password login (real Supabase Auth grant, but
 * RLS-powerless against live owner data) is the same known-limited fallback
 * this file already had before m5-01.
 *
 * m5-01 (docs/planning/05-d-prompt-organizer.md section 2): web/index.html's
 * password-grant sign-in form is gone -- the page now boots by reading an
 * already-issued access token from sessionStorage (its own manual-check
 * convenience, never the Shell's real session). This test seeds that same
 * sessionStorage key via page.addInitScript BEFORE navigating, so by the
 * time index.html's module script runs, it finds a token already in place
 * and unlocks automatically -- no form-filling step needed at all now.
 *
 * Evidence written by Playwright:
 *   playwright-report/   — HTML report
 *   test-results/        — per-test screenshots and traces
 */

import { test, expect } from "@playwright/test";
// helpers.mjs lives at tests/helpers.mjs; from tests/e2e/ the relative path
// is one level up. It exports login, rest, USER_A (and USER_B), all of which
// are used by every integration test in tests/*.test.mjs.
import { login, rest, USER_A } from "../../backend/tests/helpers.mjs";

// Must match web/index.html's own TOKEN_STORAGE_KEY constant exactly --
// that file has no bundler/export surface to import this from, so both
// sides carry the literal in a comment pointing at the other.
const TOKEN_STORAGE_KEY = "prompt-organizer-manual-check-token";

// ---------------------------------------------------------------------------
// Fixture data — unique per run so concurrent CI runs don't collide.
// ---------------------------------------------------------------------------
const RUN_ID = Date.now();
const PROMPT_TITLE = `e2e-critical-flow-${RUN_ID}`;
const PROMPT_BODY = "Deploy {{REPO}} to production.";
const VARIABLE_VALUE = "toolbelt";
const EXPECTED_RENDERED = "Deploy toolbelt to production.";

// Captured as soon as the run has a token so the afterEach below can archive
// this run's row even when the journey dies before reaching its own teardown.
let cleanupToken = null;

// ---------------------------------------------------------------------------
// T-E-001 — Critical prompt flow acceptance proof
// ---------------------------------------------------------------------------
test("critical_prompt_flow__unlock_save_render_copy__T_E_001", async ({
  page,
  context,
}) => {
  const user = {
    email: process.env.USER_A_EMAIL ?? USER_A.email,
    password: process.env.USER_A_PASSWORD ?? USER_A.password,
  };
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8812";
  const ownerToken = process.env.TOOLBELT_OWNER_TOKEN || undefined;

  // Grant clipboard permissions so navigator.clipboard.writeText works in the
  // headless Chromium context without user-gesture blocking.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // Owner-credential threading (see header comment): resolve the real token
  // ONCE, before navigating, then seed it into sessionStorage so
  // index.html's own boot check finds it already there.
  const token = ownerToken || (await login(user));
  cleanupToken = token;
  await page.addInitScript(
    ([storageKey, value]) => {
      sessionStorage.setItem(storageKey, value);
    },
    [TOKEN_STORAGE_KEY, token]
  );

  // ---- Step 1: Navigate -- the page unlocks itself from the seeded token --
  await page.goto(baseUrl);
  await expect(page.locator("h1")).toContainText("Prompt Organizer");
  await expect(page.locator("#token-form")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#app")).toBeVisible({ timeout: 15_000 });

  // ---- Step 2: Save a new prompt that contains a {{REPO}} variable ---------
  await page.fill("#title", PROMPT_TITLE);
  await page.fill("#body", PROMPT_BODY);
  await page.click('#save-form button[type="submit"]');

  const saveError = page.locator("#save-error");
  const promptSummary = page.locator("#prompt-list summary", {
    hasText: PROMPT_TITLE,
  });

  // Wait on the save actually SETTLING rather than on a fixed slice of time.
  // When the POST is rejected -- an expired owner token, a 429 from a
  // concurrent run, a unique-title conflict -- the client puts the real
  // reason in #save-error and never adds a row, so waiting only on the
  // summary reported a bare "element(s) not found" and threw the actual
  // cause away (issue #249). Poll for either outcome, then assert which one
  // it was, so a rejected save fails naming its own reason.
  await expect
    .poll(
      async () => {
        if ((await saveError.innerText()).trim() !== "") return "rejected";
        return (await promptSummary.count()) > 0 ? "rendered" : "pending";
      },
      {
        timeout: 15_000,
        message: "the save neither rendered a row nor reported an error",
      }
    )
    .not.toBe("pending");

  await expect(saveError, "the save POST must not have been rejected").toHaveText("");
  await expect(promptSummary).toBeVisible({ timeout: 10_000 });

  // ...and it must be in the database, not only in the client's optimistic
  // in-memory copy: the save handler renders the new row without re-reading
  // it back, so the DOM alone cannot distinguish "persisted" from "rendered
  // from what we just posted". Read it back over REST -- a different
  // transport than the one under test -- for an independent oracle.
  const persisted = await rest(
    `prompt?title=eq.${encodeURIComponent(PROMPT_TITLE)}&select=title,body`,
    { token }
  );
  expect(persisted.status, "the saved prompt must be readable back over REST").toBeLessThan(400);
  expect(persisted.json, "exactly one persisted row must carry this run's title and body").toEqual([
    { title: PROMPT_TITLE, body: PROMPT_BODY },
  ]);

  // ---- Step 3: Open the render panel ---------------------------------------
  // Clicking the <summary> expands the <details> which contains the panel.
  // No settle sleep: Playwright waits for actionability on its own, and the
  // list no longer re-renders underneath this click now that a superseded
  // fetch cannot replace it (issue #249).
  await promptSummary.click();

  // Scope every render-panel interaction to the prompt created by this run.
  // The shared fixture account intentionally contains many other prompts.
  const promptDetails = page.locator("#prompt-list details", {
    has: page.locator("summary", { hasText: PROMPT_TITLE }),
  });
  const repoInput = promptDetails.getByRole("textbox", {
    name: "REPO",
    exact: true,
  });
  await expect(repoInput).toBeVisible({ timeout: 5_000 });

  // ---- Step 4: Fill the variable and copy the rendered text ----------------
  await repoInput.fill(VARIABLE_VALUE);

  await promptDetails.locator('button:has-text("Copy rendered text")').click();

  // The panel shows "Copied!" after a successful navigator.clipboard.writeText.
  // Increased timeout to account for clipboard operations and usage logging.
  await expect(
    promptDetails.locator("p", { hasText: "Copied!" })
  ).toBeVisible({ timeout: 8_000 });

  // ---- Step 5: Verify the clipboard holds the correctly rendered text ------
  const clipboardText = await page.evaluate(() =>
    navigator.clipboard.readText()
  );
  expect(clipboardText).toBe(EXPECTED_RENDERED);

  // ---- Step 6: Capture screenshot evidence ---------------------------------
  await page.screenshot({
    path: `test-results/critical-flow-${RUN_ID}.png`,
    fullPage: false,
  });
});

// ---- Teardown: archive the test prompt via the REST API --------------------
// Archiving (not hard-deleting) aligns with ADR-0002 soft-delete policy. No
// DELETE grant exists on prompt.prompt (AGENTS.md invariant). Reuse the exact
// same token this run unlocked with.
//
// An afterEach, not the last statement of the test: as the final line it was
// skipped by every failing run, so each flake left a permanently is_active row
// on the shared owner account forever. Nothing prunes prompt.prompt and the
// list query is unfiltered and unbounded, so those rows are re-downloaded on
// every page load thereafter -- a failing run made the next run slower, and a
// silent PATCH failure did the same (issue #249). Assert the status so it
// cannot fail quietly again.
test.afterEach(async () => {
  if (!cleanupToken) return;
  const archived = await rest(
    `prompt?title=eq.${encodeURIComponent(PROMPT_TITLE)}`,
    { token: cleanupToken, method: "PATCH", body: { is_active: false } }
  );
  expect(
    archived.status,
    `this run's prompt must be archived, or it accumulates on the shared owner account forever (got ${archived.status})`
  ).toBeLessThan(400);
});
