// TEMPORARY -- issue #148 evidence-path proof. Deliberately fails so one CI
// run produces a real trace/screenshot, proving the upload step now finds
// them. Deleted before this branch's PR is opened; must never reach main.
import { test, expect } from "@playwright/test";

test("EVIDENCE CANARY (temporary): deliberately fails to prove the artifact upload path", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toContainText("this text does not exist anywhere in the Shell");
});
