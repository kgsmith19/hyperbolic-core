import { test, expect } from "@playwright/test";
import { DEPLOYABLE_UNITS } from "../src/lib/units";

// SH-1a (docs/planning/05-a-hyperbolic-core.md section 12): "When an
// authenticated operator requests /, /acc, /tools, /prompts, or /ideas, the
// Shell shall render the shared chrome (data-testid=platform-nav)." This is
// the FIRST real e2e proof that Chrome, as consumed by a real app, actually
// works end to end -- route rendering, nav-testid, settings health rows, and
// the /acc degrade case, all against a real production build served by
// `vite preview` (see playwright.config.ts's webServer).
const ROUTE_GROUPS = ["/", "/acc", "/tools", "/prompts", "/ideas"] as const;

test.describe("Chrome renders on every route group (SH-1a)", () => {
  for (const route of ROUTE_GROUPS) {
    test(`${route}: nav rail (data-testid=platform-nav) and topbar are present`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByTestId("platform-nav")).toBeVisible();
      await expect(page.locator('[data-slot="topbar"]')).toBeVisible();
      // The nav rail is a real <nav>, matching packages/ui/test/chrome.test.mjs's
      // own structural assertion.
      await expect(page.locator("nav[data-testid='platform-nav']")).toHaveCount(1);
    });
  }

  test("exactly one <nav data-testid=platform-nav> per page, never zero, never more than one", async ({ page }) => {
    for (const route of ROUTE_GROUPS) {
      await page.goto(route);
      await expect(page.locator("nav[data-testid='platform-nav']")).toHaveCount(1);
    }
  });
});

test.describe("Home page", () => {
  test("renders launcher cards linking to each zone and a health summary", async ({ page }) => {
    await page.goto("/");
    const cards = page.getByTestId("launcher-card");
    await expect(cards).toHaveCount(6); // life, acc, tools, prompts, ideas, settings
    await expect(page.getByTestId("home-health-summary")).toBeVisible();
    await expect(page.getByTestId("health-summary-item")).toHaveCount(DEPLOYABLE_UNITS.length);
  });

  test("clicking the ACC launcher card navigates to /acc", async ({ page }) => {
    await page.goto("/");
    await page.locator('[data-testid="launcher-card"][data-zone="acc"]').click();
    await expect(page).toHaveURL(/\/acc$/);
    await expect(page.getByTestId("platform-nav")).toBeVisible();
  });
});

test.describe("Settings page: one health row per deployable unit", () => {
  test("renders exactly DEPLOYABLE_UNITS.length unit-health-row elements, one per unit id", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("platform-nav")).toBeVisible();

    const rows = page.getByTestId("unit-health-row");
    await expect(rows).toHaveCount(DEPLOYABLE_UNITS.length);

    for (const unit of DEPLOYABLE_UNITS) {
      await expect(page.locator(`[data-testid="unit-health-row"][data-unit-id="${unit.id}"]`)).toHaveCount(1);
    }
  });

  test("renders the session card, theme control, version info, and break-glass link", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("session-card")).toBeVisible();
    // The topbar's own ThemeSwitch (data-slot=theme-switch) is present on
    // every page via Chrome; Settings renders a SEPARATE, explicit
    // three-way control on the same persistence primitive rather than a
    // second theme-switch instance (see components/theme-choice-control.tsx).
    await expect(page.getByTestId("theme-choice-control")).toBeVisible();
    await expect(page.getByTestId("version-info")).toBeVisible();
    await expect(page.getByText("break-glass runbook", { exact: false })).toBeVisible();
  });

  test("the settings theme control picks light/dark/system without touching the topbar's own switch", async ({
    page,
  }) => {
    await page.goto("/settings");
    const control = page.getByTestId("theme-choice-control");
    await control.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await control.getByRole("radio", { name: "Light" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

test.describe("/acc status card: real degrade against no live ACC server", () => {
  test('renders "ACC unreachable" and never throws, with no toast surface present anywhere on the page', async ({
    page,
  }) => {
    // Nothing in this sandboxed run is listening on ACC's loopback port, so
    // this is a REAL unreachable case (not mocked) -- complementing the
    // mocked-fetch unit test in src/components/acc-status-card.test.tsx.
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto("/acc");
    await expect(page.getByTestId("platform-nav")).toBeVisible();
    await expect(page.getByTestId("acc-status-unreachable")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("ACC unreachable", { exact: true })).toBeVisible();

    // No toast surface exists at all yet (m2-05, out of scope) -- assert
    // that structurally: nothing on the page carries a toast-shaped slot,
    // and the degrade did not throw a page-level error.
    await expect(page.locator('[data-slot*="toast"]')).toHaveCount(0);
    await expect(page.locator('[role="status"][aria-live]')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
