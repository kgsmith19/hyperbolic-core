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
 *   PLAYWRIGHT_BASE_URL  — URL of the running app   (default: http://localhost:8812)
 *   USER_A_EMAIL         — sign-in e-mail           (default: fixture user A)
 *   USER_A_PASSWORD      — sign-in password         (default: fixture user A)
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

  // Grant clipboard permissions so navigator.clipboard.writeText works in the
  // headless Chromium context without user-gesture blocking.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

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
  const promptSummary = page.locator("#prompt-list summary", {
    hasText: PROMPT_TITLE,
  });
  await expect(promptSummary).toBeVisible({ timeout: 5_000 });

  // ---- Step 3: Open the render panel ---------------------------------------
  // Clicking the <summary> expands the <details> which contains the panel.
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
  await expect(repoInput).toBeVisible({ timeout: 3_000 });

  // ---- Step 4: Fill the variable and copy the rendered text ----------------
  await repoInput.fill(VARIABLE_VALUE);

  await promptDetails.locator('button:has-text("Copy rendered text")').click();

  // The panel shows "Copied!" after a successful navigator.clipboard.writeText.
  await expect(
    promptDetails.locator("p", { hasText: "Copied!" })
  ).toBeVisible({ timeout: 5_000 });

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
  // No DELETE grant exists on prompt.prompt (AGENTS.md invariant).
  const token = await login(user);
  await rest(
    `prompt?title=eq.${encodeURIComponent(PROMPT_TITLE)}`,
    { token, method: "PATCH", body: { is_active: false } }
  );
});
