/**
 * T-E-001 — Browser acceptance proof for the highest-value Prompt Organizer
 * user flow: sign-in → save prompt with variable → open render panel →
 * fill variable → copy rendered text → verify clipboard → cleanup.
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
 *   USER_A_EMAIL          — sign-in e-mail           (default: fixture user A)
 *   USER_A_PASSWORD       — sign-in password         (default: fixture user A)
 *   TOOLBELT_OWNER_TOKEN  — real owner session, see "Owner-credential
 *                           threading" below (default: unset)
 *
 * Owner-credential threading (toolbelt-ci.yml P1 finding): once prompt.* RLS
 * is pinned to the real owner (20260812180000_prompt_owner_pin.sql), signing
 * in as fixture user A gets a real Supabase session but every subsequent
 * write this flow depends on (save, tag, usage-on-copy) is RLS-denied, so
 * the "happy path" this test exists to prove would silently stop proving it.
 * Unlike the Node suite, this flow cannot just swap in primaryToken() and
 * call it via the REST harness -- the app's own sign-in form
 * (web/index.html) only ever does a live email+password grant, and no
 * coding session holds the real owner's password, only an access token
 * (docs/notes/2026-08-12-platform-idp-owner-setup.md step 3). So instead of
 * typing real owner credentials into the form, this test intercepts the
 * form's own auth request and substitutes TOOLBELT_OWNER_TOKEN for the
 * response's access_token when the env var is set -- the app never notices
 * the difference, since it only ever reads `body.access_token` from that
 * response (web/index.html's sign-in handler). Falls back to a real fixture-
 * A password login (today's behavior) when TOOLBELT_OWNER_TOKEN is unset.
 *
 * Evidence written by Playwright:
 *   playwright-report/   — HTML report
 *   test-results/        — per-test screenshots and traces
 */

import { test, expect } from "@playwright/test";
// helpers.mjs lives at tests/helpers.mjs; from tests/e2e/ the relative path
// is one level up. It exports login, rest, USER_A (and USER_B), all of which
// are used by every integration test in tests/*.test.mjs.
import { login, rest, USER_A, SUPABASE_URL } from "../helpers.mjs";

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
test("critical_prompt_flow__sign_in_save_render_copy__T_E_001", async ({
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

  // Owner-credential threading (see header comment): substitute the owner's
  // token for the form's own auth response instead of performing a live
  // password grant. The form fields below are still filled (the app needs
  // *some* submit-worthy values) but their content is never actually
  // authenticated against Supabase when this route is active.
  if (ownerToken) {
    await page.route(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access_token: ownerToken, token_type: "bearer" }),
      });
    });
  }

  // ---- Step 1: Navigate and sign in ----------------------------------------
  await page.goto(baseUrl);
  await expect(page.locator("h1")).toContainText("Prompt Organizer");

  await page.fill("#email", user.email);
  await page.fill("#password", user.password);
  await page.click('button[type="submit"]');

  // #app becomes visible only after a successful sign-in response.
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
  // No DELETE grant exists on prompt.prompt (AGENTS.md invariant). Must
  // match whichever identity actually signed in above: the owner token when
  // the route substitution was active, otherwise a real fixture-A login.
  const token = ownerToken || (await login(user));
  await rest(
    `prompt?title=eq.${encodeURIComponent(PROMPT_TITLE)}`,
    { token, method: "PATCH", body: { is_active: false } }
  );
});
