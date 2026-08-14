// m6-02 (docs/planning/issues/m6-02-feat-shell-cost-dashboard.md) own
// Verification text: "Playwright dashboard spec comparing rendered totals
// against psql group-by output for seeded fixtures", "Attribution case in
// the same spec", "Perf trace assertion for the render budget".
//
// Two backends, two established e2e techniques (both already in this
// suite, neither invented for this spec):
//   - core.llm_call: a REAL local Postgres + a small SQL-backed shim
//     (./support/cost-fixture.ts, same technique as ./support/registry-
//     fixture.ts) -- so the "matches direct SQL group-bys" criterion is
//     checked against an actual `group by caller_app, purpose` query, not a
//     mock.
//   - services/brain's own GET /api/brain/cost: stubbed via page.route(),
//     the same technique e2e/brain-run.spec.ts already uses for every other
//     Brain HTTP route (see that spec's own header comment: standing up a
//     real Brain daemon is out of budget; this repo's own precedent is to
//     stub its documented HTTP contract and run the Shell's own code
//     entirely real and unmocked against it).
import { expect, test, type Page } from "@playwright/test";
import { fillAndSubmitLogin, mockAuth } from "./support/auth";
import { setupCostFixture, type CostFixture, type LlmCallFixtureRow } from "./support/cost-fixture";

const BRAIN_BASE = "http://127.0.0.1:8100";

let fixture: CostFixture;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = await setupCostFixture();
});

test.afterAll(() => {
  fixture?.teardown();
});

function llmCallRow(overrides: Partial<LlmCallFixtureRow> = {}): LlmCallFixtureRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ts: "2026-01-01T00:00:00Z",
    caller_app: "brain",
    purpose: "plan",
    run_ref: "run-42",
    provider: "anthropic",
    model: "claude-sonnet-5",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 10,
    usd_estimate: 0.5,
    latency_ms: 1200,
    status: "ok",
    error_class: null,
    ...overrides,
  };
}

// Seeded once, in beforeAll below, and read by every test in this file
// (serial mode): row A and D share a caller_app+purpose bucket but have
// DIFFERENT run_ref values -- this is the fixture the attribution case
// checks against ("resolve per run_ref exactly as inserted" only means
// something when two rows in the same bucket don't collapse to one ref).
const ROW_A = llmCallRow({ id: "11111111-1111-4111-8111-111111111111", caller_app: "brain", purpose: "plan", run_ref: "run-42", usd_estimate: 0.5 });
const ROW_B = llmCallRow({ id: "22222222-2222-4222-8222-222222222222", caller_app: "brain", purpose: "eval", run_ref: "run-42", usd_estimate: 0.2, ts: "2026-01-01T01:00:00Z" });
const ROW_C = llmCallRow({ id: "33333333-3333-4333-8333-333333333333", caller_app: "idea-intake", purpose: "optimize-idea", run_ref: null, usd_estimate: 0.1, ts: "2026-01-01T02:00:00Z" });
const ROW_D = llmCallRow({ id: "44444444-4444-4444-8444-444444444444", caller_app: "brain", purpose: "plan", run_ref: "run-43", usd_estimate: 0.3, ts: "2026-01-01T03:00:00Z" });

test.beforeAll(() => {
  for (const row of [ROW_A, ROW_B, ROW_C, ROW_D]) fixture.insertLlmCall(row);
});

const BRAIN_COST_SUMMARY = {
  byRun: [
    { key: "run-e2e-1", count: 2, inputTokens: 300, outputTokens: 150, cacheReadTokens: 20, usdEstimate: 0.75 },
  ],
  byTask: [
    { key: "task-e2e-1", count: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, usdEstimate: 0.25 },
    { key: "task-e2e-2", count: 1, inputTokens: 200, outputTokens: 100, cacheReadTokens: 10, usdEstimate: 0.5 },
  ],
  byHarness: [
    { key: "codex", count: 2, inputTokens: 300, outputTokens: 150, cacheReadTokens: 20, usdEstimate: 0.75 },
  ],
  byDay: [
    { key: "2026-01-01", count: 2, inputTokens: 300, outputTokens: 150, cacheReadTokens: 20, usdEstimate: 0.75 },
  ],
};

async function mockRestLlmCall(page: Page): Promise<void> {
  await page.route("**/rest/v1/llm_call**", async (route) => {
    const reqUrl = new URL(route.request().url());
    const shimUrl = `${fixture.shimBaseUrl}/rest/v1/llm_call${reqUrl.search}`;
    const res = await fetch(shimUrl);
    const body = await res.text();
    await route.fulfill({ status: res.status, contentType: "application/json", body });
  });
}

async function mockBrainCost(page: Page): Promise<void> {
  await page.route(`${BRAIN_BASE}/api/brain/cost**`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(BRAIN_COST_SUMMARY) });
  });
}

async function signInAndGoToCostDashboard(page: Page): Promise<void> {
  await mockAuth(page);
  await mockRestLlmCall(page);
  await mockBrainCost(page);
  await page.goto("/acc/cost");
  await fillAndSubmitLogin(page);
  await page.waitForURL((url) => url.pathname === "/acc/cost");
}

test.describe("Brain-native breakdown (byRun/byTask/byHarness/byDay)", () => {
  test("renders non-null totals matching GET /api/brain/cost exactly, for all four breakdowns", async ({ page }) => {
    await signInAndGoToCostDashboard(page);

    const runRow = page.locator('[data-testid="cost-bucket-row"][data-key="run-e2e-1"]');
    await expect(runRow).toBeVisible();
    await expect(runRow.locator('[data-field="count"]')).toHaveText("2");
    await expect(runRow.locator('[data-field="usdEstimate"]')).toHaveText("$0.75");

    const harnessRow = page.locator('[data-testid="cost-bucket-row"][data-key="codex"]');
    await expect(harnessRow.locator('[data-field="usdEstimate"]')).toHaveText("$0.75");

    const dayRow = page.locator('[data-testid="cost-bucket-row"][data-key="2026-01-01"]');
    await expect(dayRow.locator('[data-field="count"]')).toHaveText("2");

    // Two distinct tasks never collapse into one row -- proves the by-task
    // breakdown is real per-task granularity, not just the run total
    // repeated (the whole reason this issue reads Brain's own store instead
    // of the platform core mirror -- see cost-summary.ts's header comment).
    await expect(page.locator('[data-testid="cost-bucket-row"][data-key="task-e2e-1"] [data-field="usdEstimate"]')).toHaveText("$0.25");
    await expect(page.locator('[data-testid="cost-bucket-row"][data-key="task-e2e-2"] [data-field="usdEstimate"]')).toHaveText("$0.50");
  });
});

test.describe("core.llm_call group-bys match direct SQL exactly", () => {
  test("the caller_app+purpose table matches a real `group by caller_app, purpose` query over the seeded rows", async ({ page }) => {
    const groundTruth = fixture.queryJson<{ caller_app: string; purpose: string; call_count: number; total_usd: number }[]>(
      `select coalesce(json_agg(row_to_json(t)), '[]'::json)::text as j from (
        select caller_app, purpose, count(*) as call_count, sum(usd_estimate) as total_usd
        from core.llm_call
        group by caller_app, purpose
        order by caller_app, purpose
      ) t;`
    );
    expect(groundTruth.length).toBeGreaterThan(0); // sanity: the fixture rows are actually there

    await signInAndGoToCostDashboard(page);

    for (const bucket of groundTruth) {
      const row = page.locator(
        `[data-testid="cost-caller-purpose-row"][data-caller-app="${bucket.caller_app}"][data-purpose="${bucket.purpose}"]`
      );
      await expect(row).toBeVisible();
      await expect(row.locator('[data-field="count"]')).toHaveText(String(bucket.call_count));
      await expect(row.locator('[data-field="usdEstimate"]')).toHaveText(`$${Number(bucket.total_usd).toFixed(2)}`);
    }

    // Ground truth itself proves the two same-caller_app-different-run_ref
    // rows (A, D) really do combine into ONE brain/plan bucket in Postgres
    // -- the panel matching that (rather than showing 2 separate brain/plan
    // rows) is what "matches direct SQL group-bys" means, not a coincidence
    // of the fixture data.
    const brainPlan = groundTruth.find((b) => b.caller_app === "brain" && b.purpose === "plan");
    expect(brainPlan?.call_count).toBe(2);
  });
});

test.describe("Attribution resolves per caller_app and per run_ref exactly as inserted", () => {
  test("two calls in the SAME caller_app+purpose bucket keep their own distinct run_ref in the recent-calls list", async ({ page }) => {
    await signInAndGoToCostDashboard(page);

    const rowA = page.locator(`[data-testid="cost-llm-call-row"][data-call-id="${ROW_A.id}"]`);
    await expect(rowA).toBeVisible();
    await expect(rowA).toHaveAttribute("data-run-ref", "run-42");
    await expect(rowA).toHaveAttribute("data-caller-app", "brain");

    const rowD = page.locator(`[data-testid="cost-llm-call-row"][data-call-id="${ROW_D.id}"]`);
    await expect(rowD).toHaveAttribute("data-run-ref", "run-43");
    await expect(rowD).toHaveAttribute("data-caller-app", "brain");

    // A different caller_app (idea-intake, row C) with a null run_ref
    // renders distinctly too -- never silently attributed to "brain".
    const rowC = page.locator(`[data-testid="cost-llm-call-row"][data-call-id="${ROW_C.id}"]`);
    await expect(rowC).toHaveAttribute("data-caller-app", "idea-intake");
    await expect(rowC.locator('[data-field="runRef"]')).toHaveText("—");
  });
});

test.describe("Render budget (m6-02: p95 <= 500ms warm)", () => {
  test("session-ready to cost-dashboard-painted: p95 <= 500ms over repeated warm navigations", async ({ page }) => {
    await mockAuth(page);
    await mockRestLlmCall(page);
    await mockBrainCost(page);

    const samples: number[] = [];
    const RUNS = 10;

    for (let i = 0; i < RUNS; i += 1) {
      await page.goto("/acc/cost");
      await fillAndSubmitLogin(page);

      const start = performance.now();
      await page.waitForURL((url) => url.pathname === "/acc/cost");
      await page.getByTestId("cost-dashboard-page").waitFor({ state: "visible" });
      samples.push(performance.now() - start);

      await page.locator('[data-slot="sign-out-button"]').click();
      await page.waitForURL((url) => url.pathname === "/login");
    }

    samples.sort((a, b) => a - b);
    const p95Index = Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1);
    const p95 = samples[p95Index];
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

    // eslint-disable-next-line no-console
    console.log(
      `[perf] cost dashboard render over ${RUNS} warm runs: mean=${mean.toFixed(2)}ms p95=${p95.toFixed(2)}ms samples=${samples.map((s) => s.toFixed(1)).join(",")}ms`
    );

    expect(p95).toBeLessThanOrEqual(500);
  });
});
