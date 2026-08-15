// m4-16's own Verification command: "cd apps/shell && npx playwright test
// e2e/brain-run.spec.ts (reconnect case kills the socket and asserts
// resumed state)". Backend fidelity note: unlike e2e/ideas.spec.ts (a real
// local Postgres + real services/llm-handler fixture), services/brain is a
// long-lived daemon with a SQLite store and an ACC-kernel subprocess
// harness -- standing one up as a real e2e fixture is out of this issue's
// budget. This spec instead stubs the Brain's documented HTTP+SSE contract
// (m4-14) via page.route(), the same technique e2e/tools.spec.ts's
// mockRegistry and e2e/acc-bridge.spec.ts already use for their own
// backends; the Shell's own code (src/lib/brain-run.ts, src/lib/use-brain-
// run-stream.ts, src/pages/acc/brain.tsx) runs entirely real and unmocked.
//
// "Kills the socket" is simulated the way it actually manifests to this
// client: the stubbed /events response ends (the reader's `read()` resolves
// `done: true`), which is exactly what a real dropped TCP connection or a
// killed services/brain process produces from `fetch()`'s point of view.
// The reconnect that follows exercises the real Last-Event-ID resume logic
// in use-brain-run-stream.ts, not a fake shortcut.
import { expect, test, type Page } from "@playwright/test";
import { fillAndSubmitLogin, mockAuth } from "./support/auth";

const BRAIN_BASE = "http://127.0.0.1:8100";
const RUN_ID = "run-e2e-0001";
const TASK_ID = "task-e2e-0001";

function sseFrame(id: number, kind: string, data: Record<string, unknown>): string {
  const payload = { runId: RUN_ID, kind, ts: new Date().toISOString(), ...data };
  return `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function taskRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TASK_ID,
    runId: RUN_ID,
    title: "Refactor the parser",
    status: "awaiting_approval",
    contractJson: "{}",
    resultJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

async function mockBrainRunLifecycle(
  page: Page,
  { runStatus = "running", tasks = [taskRow()] }: { runStatus?: string; tasks?: ReturnType<typeof taskRow>[] } = {}
): Promise<void> {
  await page.route(`${BRAIN_BASE}/api/brain/runs`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ run_id: RUN_ID, task_ids: tasks.map((t) => t.id) }),
    });
  });
  await page.route(`${BRAIN_BASE}/api/brain/runs/${RUN_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: RUN_ID,
          objective: "Refactor the parser",
          autonomy: 0,
          status: runStatus,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        tasks,
      }),
    });
  });
  await page.route(`${BRAIN_BASE}/api/brain/tasks/${TASK_ID}/approve`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task_id: TASK_ID, status: "queued" }) });
  });
  await page.route(`${BRAIN_BASE}/api/brain/tasks/${TASK_ID}/reject`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task_id: TASK_ID, status: "rejected" }) });
  });
}

/** Each call to the /events route returns the next batch in order (clamped to the last once exhausted), simulating one connection per batch. */
async function mockBrainEventBatches(page: Page, batches: string[]): Promise<void> {
  let call = 0;
  await page.route(`${BRAIN_BASE}/api/brain/runs/${RUN_ID}/events`, async (route) => {
    const body = batches[Math.min(call, batches.length - 1)]!;
    call += 1;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
}

async function signInAndGoToRun(page: Page): Promise<void> {
  await mockAuth(page);
  await page.goto(`/acc/brain?run=${RUN_ID}`);
  await fillAndSubmitLogin(page);
  await page.waitForURL((url) => url.pathname === "/acc/brain");
}

test.describe("Reconnect resumes with no lost state (BR-4)", () => {
  test("a dropped connection reconnects and the transcript keeps the pre-drop event while adding the post-reconnect one", async ({ page }) => {
    await mockBrainRunLifecycle(page);
    await mockBrainEventBatches(page, [
      sseFrame(0, "run.submitted", {}),
      sseFrame(1, "task.parked_for_approval", { taskId: TASK_ID, reason: "write deliverable at autonomy 1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ]);

    await signInAndGoToRun(page);

    // First connection's event lands.
    await expect(page.getByText("Run submitted")).toBeVisible();

    // The stubbed stream having ended is the "kill the socket" event; the
    // real reconnect loop in use-brain-run-stream.ts picks it back up.
    // The post-reconnect event lands as an approval card...
    await expect(page.getByTestId("approval-approve")).toBeVisible({ timeout: 15_000 });
    // ...and the pre-drop system row is still there, not lost.
    await expect(page.getByText("Run submitted")).toBeVisible();
  });
});

test.describe("Approval requests render inline and publish a notification (09 section 7.4)", () => {
  test("a task.parked_for_approval event renders an approval card and a toast", async ({ page }) => {
    await mockBrainRunLifecycle(page);
    await mockBrainEventBatches(page, [
      sseFrame(0, "task.parked_for_approval", { taskId: TASK_ID, reason: "write deliverable at autonomy 1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ]);

    await signInAndGoToRun(page);

    await expect(page.getByText("Refactor the parser").first()).toBeVisible();
    await expect(page.getByTestId("approval-approve")).toBeVisible();
    await expect(page.getByTestId("approval-reject")).toBeVisible();

    const toast = page.getByTestId("toast").filter({ hasText: "Approval requested" });
    await expect(toast).toBeVisible();
  });

  test("approving calls the real approve endpoint and the card resolves", async ({ page }) => {
    await mockBrainRunLifecycle(page);
    await mockBrainEventBatches(page, [
      sseFrame(0, "task.parked_for_approval", { taskId: TASK_ID, reason: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    ]);

    let approveCalled = false;
    await page.route(`${BRAIN_BASE}/api/brain/tasks/${TASK_ID}/approve`, async (route) => {
      approveCalled = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ task_id: TASK_ID, status: "queued" }) });
    });

    await signInAndGoToRun(page);
    const approveButton = page.getByTestId("approval-approve");
    await expect(approveButton).toBeVisible();

    // Evidence gate (09 section 7.4): short reason text auto-expands and
    // the IntersectionObserver marks it seen once it is actually on
    // screen -- a real browser proof, not just the SSR-level structural
    // check packages/ui/test/chat-blocks.test.mjs already covers.
    await expect(approveButton).toBeEnabled({ timeout: 5_000 });
    await approveButton.click();

    await expect.poll(() => approveCalled).toBe(true);
    await expect(page.getByText("Approved")).toBeVisible();
  });
});

test.describe("Stop (09 section 7.3: visible whenever running, keyboard reachable, always enabled)", () => {
  test("Stop replaces Send while the run is active, and is never disabled", async ({ page }) => {
    await mockBrainRunLifecycle(page, { runStatus: "running", tasks: [taskRow({ status: "running" })] });
    await mockBrainEventBatches(page, [sseFrame(0, "run.submitted", {})]);

    await signInAndGoToRun(page);

    const stop = page.getByTestId("composer-stop");
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();
    await stop.focus();
    await expect(stop).toBeFocused();
  });
});

test.describe("Offline read-only after 10s (09 section 7.3)", () => {
  test("the composer becomes disabled with a reason once the connection has been down for 10s", async ({ page }) => {
    test.setTimeout(30_000);
    await mockBrainRunLifecycle(page);
    // Every connection attempt fails outright -- the surface never leaves "reconnecting" on its own.
    await page.route(`${BRAIN_BASE}/api/brain/runs/${RUN_ID}/events`, (route) => route.abort("connectionfailed"));

    await signInAndGoToRun(page);

    await expect(page.getByTestId("composer-disabled-reason")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("composer-input")).toBeDisabled();
  });
});
