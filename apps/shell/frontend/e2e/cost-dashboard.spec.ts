// m6-02 (docs/planning/issues/m6-02-feat-shell-cost-dashboard.md). Real
// backend, not mocked JSON: ./support/cost-fixture.ts stands up a real
// local Postgres 16 database with the real, unmodified core.run/core.cost/
// core.llm_call DDL applied. `page.route` forwards the browser's real
// requests to that real local shim (the same technique e2e/prompts.spec.ts's
// mockPromptRest already established), so src/lib/cost.ts and
// src/pages/acc/cost.tsx run entirely unmodified.
//
// Acceptance criteria this spec proves (the issue's own verification
// bullets): rendered totals match a direct SQL group-by over the same
// fixture data (not just "some number rendered"); attribution resolves per
// caller_app and purpose exactly as inserted; the panel renders within
// 500ms p95 warm.
import { test, expect, type Page } from "@playwright/test";
import { mockAuth, fillAndSubmitLogin } from "./support/auth";
import { setupCostFixture, psqlJsonQuery, type CostFixture } from "./support/cost-fixture";
import { pickHeaders } from "./support/shim.js";

let fixture: CostFixture;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = await setupCostFixture();
});

test.afterAll(() => {
  fixture?.teardown();
});

const FORWARDED_HEADERS = ["apikey", "authorization", "accept-profile", "content-profile"];

const SHIMMED_PATHS = ["/rest/v1/run", "/rest/v1/cost", "/rest/v1/llm_call"];

async function mockCostRest(page: Page): Promise<void> {
  for (const pathPrefix of SHIMMED_PATHS) {
    await page.route(`**${pathPrefix}**`, async (route) => {
      const req = route.request();
      const search = new URL(req.url()).search;
      const res = await fetch(`${fixture.shimBaseUrl}${pathPrefix}${search}`, {
        method: req.method(),
        headers: pickHeaders(req.headers(), FORWARDED_HEADERS),
      });
      const body = await res.text();
      await route.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body });
    });
  }
}

interface CostBucketFixture {
  key: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  usdEstimate: number;
}

interface BrainCostSummaryFixture {
  byRun: CostBucketFixture[];
  byTask: CostBucketFixture[];
  byHarness: CostBucketFixture[];
  byDay: CostBucketFixture[];
}

const EMPTY_BRAIN_SUMMARY: BrainCostSummaryFixture = { byRun: [], byTask: [], byHarness: [], byDay: [] };

/** GET /api/brain/cost (m6-02 hardening addition, services/brain/src/
 * cost-summary.ts): the ONE place per-task/per-harness cost granularity
 * exists, read live from the Brain's own HTTP API rather than through
 * ./support/cost-fixture.ts's PostgREST shim. Defaults to empty buckets
 * so every OTHER describe block in this file (which never seeds Brain-
 * native data) still renders a harmless "No cost recorded yet" row
 * instead of the whole page's Promise.all rejecting. */
async function mockBrainCost(page: Page, summary: BrainCostSummaryFixture = EMPTY_BRAIN_SUMMARY): Promise<void> {
  await page.route("**/api/brain/cost**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summary) });
  });
}

async function signInAndGoTo(page: Page, brainSummary?: BrainCostSummaryFixture): Promise<void> {
  await mockAuth(page);
  await mockCostRest(page);
  await mockBrainCost(page, brainSummary);
  await page.goto("/acc/cost");
  await fillAndSubmitLogin(page);
  await page.waitForURL((url) => url.pathname === "/acc/cost");
}

/** Two days, 24h apart at the same UTC clock time -- always distinct UTC
 * calendar dates (no DST in UTC), always within lib/cost.ts's own 30-day
 * llm_call window and the dashboard's unbounded run query. */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(8, 0, 0, 0);
  return d.toISOString();
}

test.describe("Brain cost per day and per run (fixture vs. real psql group-by)", () => {
  test.beforeAll(() => {
    const dayA = isoDaysAgo(2);
    const dayB = isoDaysAgo(1);
    fixture.seedBrainRun({ startedAt: dayA, endedAt: dayA, status: "ok", inputTokens: 100, outputTokens: 50, usd: 0.01 });
    fixture.seedBrainRun({ startedAt: dayA, endedAt: dayA, status: "ok", inputTokens: 200, outputTokens: 100, usd: 0.02 });
    fixture.seedBrainRun({ startedAt: dayB, endedAt: null, status: "running", inputTokens: 300, outputTokens: 150, usd: 0.05 });
  });

  test("the rendered per-day totals match a direct psql group-by over core.run/core.cost", async ({ page }) => {
    const groundTruth = psqlJsonQuery(
      fixture.dbName,
      `select to_char(date(r.started_at), 'YYYY-MM-DD') as date, count(*) as runs,
              sum(c.input_tokens) as input_tokens, sum(c.output_tokens) as output_tokens, sum(c.usd) as usd
       from core.run r join core.cost c on c.run_id = r.id
       where r.app_id = 'brain' and r.kind = 'run'
       group by 1 order by 1 desc`
    ) as Array<{ date: string; runs: number; input_tokens: number; output_tokens: number; usd: string }>;
    expect(groundTruth.length).toBeGreaterThanOrEqual(2);

    await signInAndGoTo(page);
    const rows = page.getByTestId("cost-daily-row");
    await expect(rows).toHaveCount(groundTruth.length);

    for (const [index, expected] of groundTruth.entries()) {
      const row = rows.nth(index);
      await expect(row).toContainText(expected.date);
      await expect(row).toContainText(String(expected.runs));
      await expect(row).toContainText(Number(expected.input_tokens).toLocaleString());
      await expect(row).toContainText(Number(expected.output_tokens).toLocaleString());
      await expect(row).toContainText(`$${Number(expected.usd).toFixed(4)}`);
    }
  });

  test("the rendered per-run totals match core.run/core.cost row for row", async ({ page }) => {
    const groundTruth = psqlJsonQuery(
      fixture.dbName,
      `select r.id::text, r.status, c.input_tokens, c.output_tokens, c.usd
       from core.run r join core.cost c on c.run_id = r.id
       where r.app_id = 'brain' and r.kind = 'run'
       order by r.started_at desc`
    ) as Array<{ id: string; status: string; input_tokens: number; output_tokens: number; usd: string }>;

    await signInAndGoTo(page);
    const rows = page.getByTestId("cost-run-row");
    await expect(rows).toHaveCount(groundTruth.length);

    for (const [index, expected] of groundTruth.entries()) {
      const row = rows.nth(index);
      await expect(row).toContainText(expected.id.slice(0, 8));
      await expect(row).toContainText(expected.status);
      await expect(row).toContainText(Number(expected.input_tokens + expected.output_tokens).toLocaleString());
      await expect(row).toContainText(`$${Number(expected.usd).toFixed(4)}`);
    }
  });
});

test.describe("LLM call attribution per caller_app and purpose", () => {
  test.beforeAll(() => {
    const now = new Date().toISOString();
    fixture.seedLlmCall({ ts: now, callerApp: "idea-intake", purpose: "optimize-idea", inputTokens: 100, outputTokens: 50, usdEstimate: 0.01 });
    fixture.seedLlmCall({ ts: now, callerApp: "idea-intake", purpose: "optimize-idea", inputTokens: 200, outputTokens: 100, usdEstimate: 0.02 });
    fixture.seedLlmCall({ ts: now, callerApp: "prompt-organizer", purpose: "render", inputTokens: 10, outputTokens: 5, usdEstimate: 0.001 });
  });

  test("attribution resolves per caller_app and purpose exactly as inserted, matching a direct psql group-by", async ({ page }) => {
    const groundTruth = psqlJsonQuery(
      fixture.dbName,
      `select caller_app, purpose, count(*) as calls,
              sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens, sum(usd_estimate) as usd
       from core.llm_call
       group by caller_app, purpose
       order by sum(usd_estimate) desc`
    ) as Array<{ caller_app: string; purpose: string; calls: number; input_tokens: number; output_tokens: number; usd: string }>;
    expect(groundTruth).toHaveLength(2);

    await signInAndGoTo(page);
    const rows = page.getByTestId("cost-llmcall-row");
    await expect(rows).toHaveCount(2);

    for (const [index, expected] of groundTruth.entries()) {
      const row = rows.nth(index);
      await expect(row).toContainText(expected.caller_app);
      await expect(row).toContainText(expected.purpose);
      await expect(row).toContainText(String(expected.calls));
      await expect(row).toContainText(Number(expected.input_tokens + expected.output_tokens).toLocaleString());
      await expect(row).toContainText(`$${Number(expected.usd).toFixed(4)}`);
    }

    // The two caller_app/purpose pairs must never be conflated: each row's
    // own figures belong to its own group, not a merged total.
    const idea = page.getByTestId("cost-llmcall-row").filter({ hasText: "idea-intake" });
    await expect(idea).toContainText("optimize-idea");
    await expect(idea).toContainText("$0.0300");
    const prompt = page.getByTestId("cost-llmcall-row").filter({ hasText: "prompt-organizer" });
    await expect(prompt).toContainText("render");
    await expect(prompt).toContainText("$0.0010");
  });
});

test.describe("Brain cost per task and per harness (m6-02 hardening addition: the ONE breakdown that exists only in the Brain's own SQLite store, GET /api/brain/cost)", () => {
  const BRAIN_SUMMARY: BrainCostSummaryFixture = {
    byRun: [{ key: "run-1", count: 2, inputTokens: 300, outputTokens: 150, cacheReadTokens: 0, usdEstimate: 0.06 }],
    byTask: [
      { key: "task-1", count: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, usdEstimate: 0.01 },
      { key: "task-2", count: 1, inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, usdEstimate: 0.05 },
    ],
    byHarness: [
      { key: "claude-code", count: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, usdEstimate: 0.01 },
      { key: "codex", count: 1, inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, usdEstimate: 0.05 },
    ],
    byDay: [],
  };

  test("the rendered per-task and per-harness rows match GET /api/brain/cost exactly, never collapsing distinct tasks or harnesses into one row", async ({ page }) => {
    await signInAndGoTo(page, BRAIN_SUMMARY);

    const taskRows = page.getByTestId("cost-task-table-row");
    await expect(taskRows).toHaveCount(2);
    for (const bucket of BRAIN_SUMMARY.byTask) {
      const row = taskRows.filter({ hasText: bucket.key });
      await expect(row).toContainText(String(bucket.count));
      await expect(row).toContainText(Number(bucket.inputTokens + bucket.outputTokens).toLocaleString());
      await expect(row).toContainText(`$${bucket.usdEstimate.toFixed(4)}`);
    }

    const harnessRows = page.getByTestId("cost-harness-table-row");
    await expect(harnessRows).toHaveCount(2);
    for (const bucket of BRAIN_SUMMARY.byHarness) {
      const row = harnessRows.filter({ hasText: bucket.key });
      await expect(row).toContainText(String(bucket.count));
      await expect(row).toContainText(`$${bucket.usdEstimate.toFixed(4)}`);
    }
  });
});

test.describe("Latency budget (m6-02: panel shall render within 500ms p95 warm)", () => {
  test("cost dashboard render: p95 <= 500ms over repeated warm navigations", async ({ page }) => {
    await mockAuth(page);
    await mockCostRest(page);
    await mockBrainCost(page);
    await page.goto("/acc/cost");
    await fillAndSubmitLogin(page);
    await page.waitForURL((url) => url.pathname === "/acc/cost");
    await page.getByTestId("cost-dashboard-page").waitFor({ state: "visible" });

    // Client-side transitions (nav-rail click to /acc, then the panel's
    // own in-page link to /acc/cost), not page.goto() -- a goto() forces
    // a full document reload (re-parse/re-execute the whole SPA bundle)
    // on every iteration, which e2e/chrome.spec.ts's own "internal clicks
    // stay client-side" test proves is NOT what a real warm navigation
    // between two already-loaded zones looks like, and made this budget
    // measure bundle-reload noise instead of the panel's own render cost.
    const accNavRailItem = page.locator('nav[data-testid="platform-nav"] [data-slot="nav-rail-item"][data-zone="acc"]');
    const samples: number[] = [];
    const RUNS = 12;
    for (let i = 0; i < RUNS; i += 1) {
      await accNavRailItem.click();
      // toHaveURL polls the current URL rather than waiting for a "load"
      // event (waitForURL's default) -- a client-side route change never
      // fires one, the same reason e2e/chrome.spec.ts's own client-side-nav
      // assertions use toHaveURL, never waitForURL, after a nav-rail click.
      await expect(page).toHaveURL(/\/acc\/?$/);
      const start = performance.now();
      await page.getByTestId("cost-dashboard-link").click();
      await page.getByTestId("cost-dashboard-page").waitFor({ state: "visible" });
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p95Index = Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1);
    const p95 = samples[p95Index]!;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

    // eslint-disable-next-line no-console
    console.log(
      `[perf] cost dashboard render over ${RUNS} warm navigations: mean=${mean.toFixed(2)}ms p95=${p95.toFixed(2)}ms samples=${samples.map((s) => s.toFixed(1)).join(",")}ms`
    );

    expect(p95).toBeLessThanOrEqual(500);
  });
});
