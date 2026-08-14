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
import { login, rest, USER_A } from "../helpers.mjs";

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

  // The new prompt's summary must appear in #prompt-list.
  // Increased timeout to account for network latency and DOM rendering.
  const promptSummary = page.locator("#prompt-list summary", {
    hasText: PROMPT_TITLE,
  });
  await expect(promptSummary).toBeVisible({ timeout: 10_000 });

  // ---- Step 3: Open the render panel ---------------------------------------
  // Clicking the <summary> expands the <details> which contains the panel.
  // Small delay to ensure DOM has fully settled after the list update.
  await page.waitForTimeout(200);
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
  // Increased timeout to account for render panel initialization.
  await expect(repoInput).toBeVisible({ timeout: 5_000 });

  // ---- Step 4: Fill the variable and copy the rendered text ----------------
  // Small delay to ensure input is fully interactive before filling.
  await page.waitForTimeout(100);
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

  // ---- Teardown: archive the test prompt via the REST API ------------------
  // Archiving (not hard-deleting) aligns with ADR-0002 soft-delete policy.
  // No DELETE grant exists on prompt.prompt (AGENTS.md invariant). Reuse the
  // exact same token this test unlocked with above.
  await rest(
    `prompt?title=eq.${encodeURIComponent(PROMPT_TITLE)}`,
    { token, method: "PATCH", body: { is_active: false } }
  );
});
