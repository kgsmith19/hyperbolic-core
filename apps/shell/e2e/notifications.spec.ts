// m2-05 verification (docs/planning/issues/m2-05-feat-shell-notifications.md's
// own "Verification" section): the notification surface's four acceptance
// criteria, driven against a REAL production build in a REAL Chromium (see
// playwright.config.ts's webServer -- `npm run build && npm run preview`,
// never the dev server).
//
// What is real here and what is not, stated plainly:
//   - REAL: the NotificationSurface implementation, the BroadcastChannel
//     transport, the toast stack, its timers, the bell inbox, the live
//     region, and two genuine same-origin documents for the cross-zone
//     case. Nothing about the transport is mocked or stubbed -- a fake
//     BroadcastChannel would prove nothing about cross-document delivery,
//     which is the entire point of that criterion.
//   - NOT REAL: the notification PRODUCER. Nothing in the platform
//     publishes yet -- the Brain's run events are m4-14/m4-16, named out of
//     scope by this issue -- so the spec plays that part through
//     `window.__hyperbolicNotifications`, the VITE_E2E_HOOKS-gated handle on
//     the same singleton the app itself renders from (src/lib/notifications.ts,
//     the identical mechanism m2-03 established for the platform client).
//     Every line of code downstream of `publish()` is the shipped code.
//   - STUBBED, as unrelated noise: the tools registry request, so no test
//     here depends on network reachability. It has nothing to do with
//     notifications.
//
// Timing assertions below are real measurements taken INSIDE the page with
// MutationObserver + Date.now()/performance.now(), not `expect.poll`
// intervals: a Playwright assertion poll granularity (~100ms) cannot
// honestly measure a 100ms budget.
import { test, expect, type Page } from "@playwright/test";
import { mockAuth, fillAndSubmitLogin } from "./support/auth";
import type { NotificationSurface, PlatformNotification } from "@hyperbolic/ui";

declare global {
  interface Window {
    __hyperbolicNotifications?: NotificationSurface;
    /** Set by the in-page probes below; see armToastObserver(). */
    __toastProbe?: Promise<number>;
  }
}

const TOAST = '[data-slot="toast"]';
const REGION = '[data-slot="toast-region"]';

/** The registry call protected-layout makes on every gated route. */
async function stubRegistry(page: Page): Promise<void> {
  await page.route("**/rest/v1/app**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
  );
}

/**
 * Signs in and lands on `path`. Tolerates an ALREADY-signed-in page: the
 * two-page test opens a second document in the same context, which shares
 * the first one's persisted session, so its login form never renders.
 */
async function openZone(page: Page, path: string): Promise<void> {
  await mockAuth(page);
  await stubRegistry(page);
  await page.goto(path);
  // `attached`, not the default `visible`: an EMPTY toast region has no box
  // to be visible, and its presence is precisely the signal that the chrome
  // (and therefore a signed-in session) rendered.
  await page.waitForSelector(`[data-testid="login-email"], ${REGION}`, { state: "attached" });
  if (await page.getByTestId("login-email").isVisible()) {
    await fillAndSubmitLogin(page);
  }
  await page.waitForURL((url) => url.pathname === path);
  // The live region must exist BEFORE any notification does (see
  // toast-stack.tsx: assistive tech only announces changes inside a region
  // that already existed), so this is an assertion, not just a wait.
  await expect(page.locator(REGION)).toBeAttached();
  await expect(page.locator(TOAST)).toHaveCount(0);
}

type PublishInput = Parameters<NotificationSurface["publish"]>[0];

async function publish(page: Page, notification: PublishInput): Promise<string> {
  return page.evaluate(
    (input) => window.__hyperbolicNotifications!.publish(input),
    notification
  );
}

/**
 * Arms an in-page MutationObserver that resolves with `Date.now()` the
 * moment a toast node first appears. Returns once the observer is really
 * attached, so a publish issued after this call cannot be missed.
 */
async function armToastObserver(page: Page): Promise<void> {
  await page.evaluate((regionSelector) => {
    const region = document.querySelector(regionSelector)!;
    window.__toastProbe = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        if (region.querySelector('[data-slot="toast"]')) {
          observer.disconnect();
          resolve(Date.now());
        }
      });
      observer.observe(region, { childList: true, subtree: true });
    });
  }, REGION);
}

async function awaitToastObserver(page: Page): Promise<number> {
  return page.evaluate(() => window.__toastProbe!);
}

test.describe("AC1: publish surfaces a toast within 100 ms", () => {
  test("same document: publish -> visible toast, measured in-page", async ({ page }) => {
    await openZone(page, "/");

    const latencyMs = await page.evaluate((regionSelector) => {
      const region = document.querySelector(regionSelector)!;
      const appeared = new Promise<number>((resolve) => {
        const observer = new MutationObserver(() => {
          if (region.querySelector('[data-slot="toast"]')) {
            observer.disconnect();
            resolve(performance.now());
          }
        });
        observer.observe(region, { childList: true, subtree: true });
      });
      const startedAt = performance.now();
      window.__hyperbolicNotifications!.publish({
        level: "info",
        title: "Same-document toast",
        source: "shell",
      });
      return appeared.then((appearedAt) => appearedAt - startedAt);
    }, REGION);

    // eslint-disable-next-line no-console -- the measured number IS the evidence
    console.log(`[m2-05] same-document publish -> toast in DOM: ${latencyMs.toFixed(1)} ms`);
    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(latencyMs).toBeLessThan(100);

    const toast = page.locator(TOAST);
    await expect(toast).toHaveCount(1);
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Same-document toast");
    await expect(toast).toHaveAttribute("data-level", "info");
  });

  test("two same-origin documents: BroadcastChannel delivery, measured on a shared wall clock", async ({
    context,
  }) => {
    // Two REAL pages in one context: same origin, same storage partition,
    // two separate documents with two separate JS realms -- which is
    // exactly the situation 05-a section 7's transport paragraph is about
    // (a LifeOS bundle and a Shell bundle on one origin). Nothing about
    // BroadcastChannel is faked; the second page's toast can only exist if
    // the real channel delivered.
    const zoneA = await context.newPage();
    const zoneB = await context.newPage();
    await openZone(zoneA, "/");
    await openZone(zoneB, "/tools");

    await armToastObserver(zoneB);

    // Both timestamps come from Date.now() in the same browser on the same
    // host, so they are directly comparable; the observer records its own
    // timestamp inside page B, so Playwright's own IPC round trip is NOT
    // included in the measurement.
    const publishedAt = await zoneA.evaluate(() => {
      const id = window.__hyperbolicNotifications!.publish({
        level: "success",
        title: "Cross-zone toast",
        body: "Published in the Shell document at /",
        source: "lifeos",
      });
      return { id, at: Date.now() };
    });
    const seenAt = await awaitToastObserver(zoneB);
    const deliveryMs = seenAt - publishedAt.at;

    // eslint-disable-next-line no-console -- the measured number IS the evidence
    console.log(`[m2-05] cross-document publish -> toast in DOM: ${deliveryMs} ms`);
    expect(deliveryMs).toBeGreaterThanOrEqual(0);
    expect(deliveryMs).toBeLessThan(100);

    const toastInB = zoneB.locator(TOAST);
    await expect(toastInB).toHaveCount(1);
    await expect(toastInB).toBeVisible();
    await expect(toastInB).toContainText("Cross-zone toast");
    await expect(toastInB).toContainText("Published in the Shell document at /");

    // The id must survive the transport, not be regenerated per document --
    // otherwise a cross-zone dismiss could never find its target.
    await expect(toastInB).toHaveAttribute("data-notification-id", publishedAt.id);
    const idsInB = await zoneB.evaluate(() =>
      window.__hyperbolicNotifications!.list().map((n: PlatformNotification) => n.id)
    );
    expect(idsInB).toEqual([publishedAt.id]);

    // And the reverse direction: dismissing in B clears A.
    await zoneB.locator('[data-slot="toast-dismiss"]').click();
    await expect(zoneA.locator(TOAST)).toHaveCount(0);
    expect(await zoneA.evaluate(() => window.__hyperbolicNotifications!.list().length)).toBe(0);

    await zoneA.close();
    await zoneB.close();
  });
});

test.describe("AC2: durations by level", () => {
  test("info auto-dismisses at ~5s and warning at ~8s, measured in-page", async ({ page }) => {
    test.setTimeout(60_000);
    await openZone(page, "/");

    const lifetimes = await page.evaluate((regionSelector) => {
      const region = document.querySelector(regionSelector)!;
      const publishedAt = Date.now();
      const surface = window.__hyperbolicNotifications!;
      const infoId = surface.publish({ level: "info", title: "Info toast", source: "shell" });
      const warnId = surface.publish({ level: "warning", title: "Warning toast", source: "shell" });

      const goneAt = (id: string) =>
        new Promise<number>((resolve) => {
          const selector = `[data-notification-id="${id}"]`;
          const observer = new MutationObserver(() => {
            if (!region.querySelector(selector)) {
              observer.disconnect();
              resolve(Date.now() - publishedAt);
            }
          });
          observer.observe(region, { childList: true, subtree: true });
        });

      return Promise.all([goneAt(infoId), goneAt(warnId)]).then(([info, warning]) => ({
        info,
        warning,
      }));
    }, REGION);

    // eslint-disable-next-line no-console -- the measured numbers ARE the evidence
    console.log(
      `[m2-05] toast lifetimes: info ${lifetimes.info} ms (spec 5000), warning ${lifetimes.warning} ms (spec 8000)`
    );
    // +-400ms: a render commit and a timer callback, nothing more. Wide
    // enough not to flake on a busy runner, far too tight to pass if the
    // level->duration table were wrong in either direction.
    expect(lifetimes.info).toBeGreaterThan(4_600);
    expect(lifetimes.info).toBeLessThan(5_400);
    expect(lifetimes.warning).toBeGreaterThan(7_600);
    expect(lifetimes.warning).toBeLessThan(8_400);
  });

  test("an error toast persists well past every auto-dismiss window, then dismisses on click", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openZone(page, "/");

    const id = await publish(page, {
      level: "error",
      title: "Run failed",
      body: "acc-api returned 500.",
      source: "brain",
    });
    const toast = page.locator(`[data-notification-id="${id}"]`);
    await expect(toast).toBeVisible();

    // Past 5s (info/success) and past 8s (warning): if error were treated as
    // any other level, it would be gone before this assertion runs.
    await page.waitForTimeout(9_000);
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("data-level", "error");

    await page.locator('[data-slot="toast-dismiss"]').click();
    await expect(toast).toHaveCount(0);
    // Dismiss is the surface-level removal of 05-a section 7, so it leaves
    // the inbox too -- it does not silently reappear behind the bell.
    expect(await page.evaluate(() => window.__hyperbolicNotifications!.list().length)).toBe(0);
    await expect(page.getByTestId("notification-bell")).toHaveAttribute("data-unread-count", "0");
  });

  test("hovering the stack pauses the timer and unhovering resumes it from where it stopped", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openZone(page, "/");

    const id = await publish(page, { level: "info", title: "Hover me", source: "shell" });
    const toast = page.locator(`[data-notification-id="${id}"]`);
    await expect(toast).toBeVisible();

    // ~1s of the 5s budget runs, then the pointer parks on the toast.
    await page.waitForTimeout(1_000);
    await toast.hover();

    // 6 more seconds under the pointer: an unpaused toast would be long
    // gone (5s), so its survival here is the pause.
    await page.waitForTimeout(6_000);
    await expect(toast).toBeVisible();

    const resumedAt = Date.now();
    await page.mouse.move(5, 5); // off the region, bottom-right corner
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
    const survivedAfterResumeMs = Date.now() - resumedAt;

    // eslint-disable-next-line no-console -- the measured number IS the evidence
    console.log(
      `[m2-05] toast survived ${survivedAfterResumeMs} ms after unhover (spec: ~4000 ms of the 5000 ms budget left)`
    );
    // Resume must CONTINUE (~4s left of 5s), not restart (~5s) and not
    // expire instantly (~0s, which is what a naive "recompute from
    // createdAt" implementation does).
    expect(survivedAfterResumeMs).toBeGreaterThan(2_500);
    expect(survivedAfterResumeMs).toBeLessThan(4_800);
  });

  test("keyboard focus inside the stack pauses the timer too, not just the pointer", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openZone(page, "/");

    const id = await publish(page, { level: "info", title: "Focus me", source: "shell" });
    const toast = page.locator(`[data-notification-id="${id}"]`);
    await expect(toast).toBeVisible();

    // 09 section 4.5 pauses on "hover/focus". Focus alone, pointer parked
    // far away, must hold the timer exactly the same way.
    await page.mouse.move(5, 5);
    await toast.locator('[data-slot="toast-dismiss"]').focus();
    await page.waitForTimeout(7_000);
    await expect(toast).toBeVisible();

    // Blur it and the countdown resumes -- and finishes.
    await page.locator('[data-slot="palette-trigger"]').focus();
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
  });
});

test.describe("AC3: at most 3 visible, older entries collapse into the bell inbox", () => {
  test("5 published -> 3 newest on screen, 2 in the inbox, unread count 2", async ({ page }) => {
    await openZone(page, "/");

    // Error level throughout so nothing can auto-dismiss mid-test: this
    // case is about the STACK limit, not about durations.
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      ids.push(await publish(page, { level: "error", title: `Notification ${n}`, source: "shell" }));
    }

    const toasts = page.locator(TOAST);
    await expect(toasts).toHaveCount(3);
    // Newest on top (09 section 4.5's Stack row).
    await expect(toasts.nth(0)).toContainText("Notification 5");
    await expect(toasts.nth(1)).toContainText("Notification 4");
    await expect(toasts.nth(2)).toContainText("Notification 3");

    const bell = page.getByTestId("notification-bell");
    await expect(bell).toHaveAttribute("data-unread-count", "2");
    await expect(bell).toHaveAttribute("aria-label", "Notifications, 2 unread");
    await expect(page.getByTestId("notification-unread-count")).toHaveText("2");

    // The two that collapsed are still there, in the inbox, newest first --
    // collapsing is a move, not a delete.
    await bell.click();
    const inboxItems = page.getByTestId("notification-inbox-item");
    await expect(inboxItems).toHaveCount(2);
    await expect(inboxItems.nth(0)).toContainText("Notification 2");
    await expect(inboxItems.nth(1)).toContainText("Notification 1");
    expect(await page.evaluate(() => window.__hyperbolicNotifications!.list().length)).toBe(5);

    // Opening the inbox is what clears "unread".
    await expect(bell).toHaveAttribute("data-unread-count", "0");
    await expect(page.getByTestId("notification-unread-count")).toHaveCount(0);

    // Dismissing an inbox row removes it from the surface entirely.
    await page.locator('[data-slot="notification-inbox-dismiss"]').first().click();
    await expect(page.getByTestId("notification-inbox-item")).toHaveCount(1);
    const remaining = await page.evaluate(() =>
      window.__hyperbolicNotifications!.list().map((n: PlatformNotification) => n.id)
    );
    expect(remaining).not.toContain(ids[1]);
    expect(remaining).toHaveLength(4);
  });

  test("an expired toast frees its slot and becomes an unread inbox entry", async ({ page }) => {
    test.setTimeout(60_000);
    await openZone(page, "/");

    await publish(page, { level: "info", title: "Ephemeral", source: "shell" });
    await expect(page.locator(TOAST)).toHaveCount(1);

    await expect(page.locator(TOAST)).toHaveCount(0, { timeout: 10_000 });
    // It expired off the screen but is still a notification the operator
    // has never acknowledged: the inbox keeps it, unread.
    await expect(page.getByTestId("notification-bell")).toHaveAttribute("data-unread-count", "1");
    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId("notification-inbox-item")).toHaveCount(1);
    await expect(page.getByTestId("notification-inbox-item")).toContainText("Ephemeral");
  });

  test("the inbox shows a designed empty state, not bare 'No data'", async ({ page }) => {
    await openZone(page, "/");
    await page.getByTestId("notification-bell").click();
    const inbox = page.getByTestId("notification-inbox");
    await expect(inbox).toBeVisible();
    await expect(inbox.locator('[data-slot="empty-state"]')).toBeVisible();
    await expect(inbox).toContainText("appear here");
  });
});

test.describe("AC4: toasts never steal focus and announce politely", () => {
  test("the toast region is a polite live region, present before any toast exists", async ({
    page,
  }) => {
    await openZone(page, "/");
    const region = page.locator(REGION);
    await expect(region).toBeAttached();
    await expect(region).toHaveAttribute("aria-live", "polite");
    // Not "true": a stack must announce the toast that arrived, not re-read
    // all three every time one does.
    await expect(region).toHaveAttribute("aria-atomic", "false");
    // Nothing assertive/alert-role anywhere in the surface: an interruption
    // budget of "never steals focus" (09 section 4.5) rules that out.
    await expect(page.locator('[aria-live="assertive"]')).toHaveCount(0);
    await expect(page.locator(`${REGION} [role="alert"]`)).toHaveCount(0);
  });

  test("publishing does not move focus, including for an error toast", async ({ page }) => {
    await openZone(page, "/");

    await page.locator('[data-slot="palette-trigger"]').focus();
    const focusedBefore = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-slot")
    );
    expect(focusedBefore).toBe("palette-trigger");

    await publish(page, { level: "error", title: "Nothing may steal focus", source: "acc" });
    await expect(page.locator(TOAST)).toHaveCount(1);

    const focusedAfter = await page.evaluate(() => ({
      slot: document.activeElement?.getAttribute("data-slot"),
      insideRegion: document
        .querySelector('[data-slot="toast-region"]')!
        .contains(document.activeElement),
    }));
    expect(focusedAfter.slot).toBe(focusedBefore);
    expect(focusedAfter.insideRegion).toBe(false);

    // Still reachable by keyboard, which is the other half of the rule:
    // never grabbed, never unreachable.
    await page.locator('[data-slot="toast-dismiss"]').focus();
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute("data-slot"))
    ).toBe("toast-dismiss");
  });
});
