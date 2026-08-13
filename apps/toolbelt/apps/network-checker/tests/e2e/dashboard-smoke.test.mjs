/**
 * D-04 — Browser acceptance proof that the dashboard actually renders real
 * data: the one human-facing surface of this product had zero coverage
 * before this spec (docs/planning/05-f-network-checker.md section 5).
 *
 * Deliberately one minimal smoke spec, not a JS unit-test harness: the 10
 * frontend/js modules are render-and-fetch glue with no algorithmic core
 * worth unit-testing in isolation, and a JS test harness would add a
 * dependency this app's zero-JS-dependency frontend stance exists to avoid
 * (see the D-04 write-up in the planning doc for the full rejection
 * rationale). Playwright itself is an accepted test-time-only tool, the
 * same precedent apps/toolbelt/apps/prompt-organizer/tests/e2e/ already
 * set for this monorepo.
 *
 * What this proves, in one pass against one already-running server:
 *   1. The sample table renders every row from a seeded fixture database.
 *   2. A sample written to that database *after* the page has loaded
 *      arrives over the live SSE channel (`GET /api/stream`), not a reload.
 *   3. The export control produces a real, well-formed download.
 *
 * Entirely hermetic: loopback only (127.0.0.1:8787 per the artifact), a
 * throwaway SQLite fixture, and one local `python3` subprocess to append
 * the live-update row -- no real probe, no live network call anywhere.
 *
 * Run (after the fixture is seeded and `python -m netcheck serve` is
 * already up against it -- see the CI wiring notes for the exact steps):
 *   npx playwright test --config playwright.config.mjs
 *
 * Env vars:
 *   PLAYWRIGHT_BASE_URL  — URL of the running dashboard (default: http://127.0.0.1:8787)
 *   PYTHON               — interpreter used to append the live-update row (default: python3)
 *
 * Evidence written by Playwright:
 *   playwright-report/   — HTML report
 *   test-results/        — per-test screenshots and traces
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test, expect } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_SCRIPT = path.join(__dirname, "seed_dashboard_fixture.py");
const PYTHON = process.env.PYTHON ?? "python3";

// Must match tests/e2e/seed_dashboard_fixture.py's FIXTURE_ROWS /
// LIVE_UPDATE_ROW exactly -- these are the fixture's contract, not
// arbitrary numbers picked to make the assertions pass.
const SEEDED_ROW_COUNT = 5;
const SEEDED_FAULT_MARKER = "321 ms";
const SEEDED_CULPRIT = "lan";
const LIVE_UPDATE_MARKER = "777 ms";
const LIVE_UPDATE_CULPRIT = "internet";

test("dashboard_smoke__fixture_rows_live_update_and_export__D_04", async ({ page }) => {
  // ---- Step 1: load the dashboard against the seeded fixture -------------
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("netcheck");

  // ---- Step 2: the sample table renders every fixture row ----------------
  const samplesTable = page.locator("#samples-table");
  const rows = samplesTable.locator("table tbody tr");
  await expect(rows).toHaveCount(SEEDED_ROW_COUNT);
  await expect(samplesTable).toContainText(SEEDED_CULPRIT);
  await expect(samplesTable).toContainText(SEEDED_FAULT_MARKER);

  // ---- Step 3: a row written straight to the fixture DB while the server
  // is already running must reach the page over SSE, with no reload -------
  execFileSync(PYTHON, [SEED_SCRIPT, "--append"], { stdio: "inherit" });
  await expect(rows).toHaveCount(SEEDED_ROW_COUNT + 1, { timeout: 10_000 });
  await expect(samplesTable).toContainText(LIVE_UPDATE_CULPRIT);
  await expect(samplesTable).toContainText(LIVE_UPDATE_MARKER);

  // ---- Step 4: the export action produces a real, well-formed download --
  const downloadPromise = page.waitForEvent("download");
  await page.click("#btn-export-json");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("netcheck-report.json");

  const downloadedPath = await download.path();
  const bundle = JSON.parse(fs.readFileSync(downloadedPath, "utf8"));
  expect(Array.isArray(bundle.samples)).toBe(true);
  expect(bundle.samples.length).toBe(SEEDED_ROW_COUNT + 1);
});
