import { expect, test } from "@playwright/test";
import { fillAndSubmitLogin, mockAuth } from "./support/auth";

const ACC_TOKEN = "A".repeat(43);
const ACC_ENDPOINT = "http://127.0.0.1:43117/api/process/status";

test("signed-out ACC bootstrap survives the login redirect without entering the return query", async ({ page }) => {
  await mockAuth(page);
  const seenTokens: Array<string | undefined> = [];
  await page.route(ACC_ENDPOINT, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": new URL(page.url()).origin,
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "X-ACC-Token, X-ACC, Content-Type",
          "Access-Control-Allow-Private-Network": "true",
        },
      });
      return;
    }
    seenTokens.push(route.request().headers()["x-acc-token"]);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": new URL(page.url()).origin },
      body: JSON.stringify({ tier: { tier: "green", pct: 1 }, weekText: "Week: $1", stopped: false }),
    });
  });

  await page.goto(`/acc#acc-token=${ACC_TOKEN}`);
  await expect(page).toHaveURL((url) => url.pathname === "/login" && url.searchParams.get("return") === "/acc");
  expect(new URL(page.url()).hash).toBe("");
  expect(page.url()).not.toContain(ACC_TOKEN);

  await fillAndSubmitLogin(page);
  await page.waitForURL((url) => url.pathname === "/acc");
  await expect(page.getByTestId("acc-status-ok")).toBeVisible();
  expect(seenTokens).toEqual([ACC_TOKEN]);
  expect(await page.evaluate(() => sessionStorage.getItem("hyperbolic-shell-acc-token"))).toBe(ACC_TOKEN);

  await page.reload();
  await expect(page.getByTestId("acc-status-ok")).toBeVisible();
  expect(seenTokens).toEqual([ACC_TOKEN, ACC_TOKEN]);
  expect(page.url()).not.toContain(ACC_TOKEN);
});
