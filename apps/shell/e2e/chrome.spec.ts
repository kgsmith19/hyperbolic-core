import { test, expect } from "@playwright/test";
import { DEPLOYABLE_UNITS } from "../src/lib/units";
import { mockAuth, fillAndSubmitLogin } from "./support/auth";

// SH-1a (docs/planning/05-a-hyperbolic-core.md section 12): "When an
// authenticated operator requests /, /acc, /tools, /prompts, or /ideas, the
// Shell shall render the shared chrome (data-testid=platform-nav)." This is
// the FIRST real e2e proof that Chrome, as consumed by a real app, actually
// works end to end -- route rendering, nav-testid, settings health rows, and
// the /acc degrade case, all against a real production build served by
// `vite preview` (see playwright.config.ts's webServer).
//
// m2-03 made every route require a real, authenticated session (this file
// predates that gate, from m2-02, when every route rendered for free under
// a permanent stub session). Every test here now logs in first through the
// real UI so "authenticated operator" -- SH-1a's own precondition -- is
// actually true, not assumed; e2e/auth-gate.spec.ts and
// e2e/single-session.spec.ts are what prove the gate and session
// propagation themselves.
const ROUTE_GROUPS = ["/", "/acc", "/tools", "/prompts", "/ideas"] as const;

test.beforeEach(async ({ page }) => {
  await mockAuth(page);
  await page.goto("/");
  await fillAndSubmitLogin(page);
  await page.waitForURL((url) => url.pathname === "/");
});

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

  // The P1 regression this spec exists to catch: LifeOS is not a Shell
  // route (app.tsx's <Routes> has no `/life` entry -- it's a SEPARATE zone
  // stitched in at the `tailscale serve` reverse-proxy layer, entirely
  // outside this SPA's bundle). A plain react-router <Link> only ever calls
  // history.pushState -- it never leaves the page, so it never issues an
  // HTTP request the reverse proxy could route -- and the click silently
  // lands on Shell's own catch-all NotFoundPage instead of the LifeOS zone.
  //
  // A unit test that only reads the anchor's `href` can't tell a fixed
  // `<Link reloadDocument>`/plain `<a>` apart from the buggy plain `<Link>`,
  // because react-router's `<Link>` always renders a real `<a href>`
  // regardless of `reloadDocument` -- the DOM shape is identical either
  // way (see src/pages/home.test.tsx's own comment for the unit-level
  // version of this same problem). The only way to actually SEE the
  // difference is at the network/navigation layer, which only an e2e
  // browser can observe, so it's asserted here rather than only in a
  // component test:
  //
  //  1. A real hard navigation makes the browser tear down and reload the
  //     JS document, wiping any in-page JS state -- a plain pushState
  //     transition never does. Stamping `window.__e2eMarker` before the
  //     click and reading it back afterward is a direct, unfakeable probe
  //     for "did the document actually reload", independent of whatever
  //     `/life/` happens to resolve to in this sandbox (there is no real
  //     LifeOS bundle or tailscale-serve proxy here -- vite preview's own
  //     SPA fallback answers with Shell's index.html either way, so the
  //     response CONTENT looks similar; only the navigation mechanism
  //     differs, and that's exactly what this asserts).
  //  2. A real navigation is also a real "document" resourceType network
  //     request for /life/ -- a pushState transition issues none at all.
  //     Asserted independently as a second, corroborating signal.
  test("clicking the LifeOS launcher card performs a real hard navigation, not a client-side route change", async ({
    page,
  }) => {
    await page.goto("/");

    await page.evaluate(() => {
      (window as unknown as { __e2eMarker?: string }).__e2eMarker = "pre-click-shell-instance";
    });

    const documentRequestToLife = page.waitForRequest(
      (req) => req.url().includes("/life/") && req.resourceType() === "document"
    );

    await page.locator('[data-testid="launcher-card"][data-zone="life"]').click();

    // Signal 2: a real, observable network request for /life/ was issued --
    // impossible for a pushState-only SPA transition, which never leaves
    // the page.
    await documentRequestToLife;

    await page.waitForURL((url) => url.pathname === "/life/");

    // Signal 1: the marker is gone because the document was torn down and
    // reloaded, not merely because the SPA re-rendered -- a pushState
    // transition to a component that doesn't touch `window.__e2eMarker`
    // would leave it untouched.
    const markerAfter = await page.evaluate(
      () => (window as unknown as { __e2eMarker?: string }).__e2eMarker
    );
    expect(markerAfter).toBeUndefined();
  });
});

// Contrast case for the LifeOS hard-navigation test above: proves the same
// two signals do NOT fire for a real in-Shell route, so "the LifeOS test
// passes" can't be explained by some sandbox quirk that makes every click
// look like a hard navigation.
test.describe("Home page: in-Shell cards stay client-side (contrast for the LifeOS hard-nav case)", () => {
  test("clicking the ACC launcher card does NOT reload the document or hit the network for /acc's HTML", async ({
    page,
  }) => {
    // No manual mockAuth/goto/login here -- this file's top-level
    // `test.beforeEach` (module scope, applies to every describe block in
    // this file, this one included) already logged the page in and landed
    // it on "/" before this test body runs.
    await page.evaluate(() => {
      (window as unknown as { __e2eMarker?: string }).__e2eMarker = "pre-click-shell-instance";
    });

    let sawDocumentRequestToAcc = false;
    const onRequest = (req: import("@playwright/test").Request) => {
      if (req.url().includes("/acc") && req.resourceType() === "document") sawDocumentRequestToAcc = true;
    };
    page.on("request", onRequest);

    await page.locator('[data-testid="launcher-card"][data-zone="acc"]').click();
    await expect(page).toHaveURL(/\/acc$/);

    page.off("request", onRequest);

    // Same document, same JS context, the whole way through -- exactly
    // what a pushState-based SPA transition guarantees and a hard
    // navigation never would.
    const markerAfter = await page.evaluate(
      () => (window as unknown as { __e2eMarker?: string }).__e2eMarker
    );
    expect(markerAfter).toBe("pre-click-shell-instance");
    expect(sawDocumentRequestToAcc).toBe(false);
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
  test('renders "ACC unreachable" and never throws, without firing a toast', async ({
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

    // Updated by m2-05, which built the toast surface this test previously
    // asserted did not exist yet. The claim worth keeping is the one about
    // THIS degrade path, and it is now sharper than "nothing toast-shaped
    // is on the page": the toast region exists (empty), and an unreachable
    // ACC does not fire a toast at all -- it renders inline, per 09 section
    // 4.4 ("Error, inline" for a failure tied to a visible surface; a toast
    // is for background work with no surface of its own). Toast behaviour
    // itself is proven in e2e/notifications.spec.ts.
    await expect(page.locator('[data-slot="toast-region"]')).toBeAttached();
    await expect(page.locator('[data-slot="toast"]')).toHaveCount(0);
    await expect(page.getByTestId("notification-bell")).toHaveAttribute("data-unread-count", "0");
    await expect(page.locator('[role="status"][aria-live]')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
