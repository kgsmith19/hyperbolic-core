// m3-07 (docs/planning/issues/m3-07-feat-intake-ui.md's own Verification
// command: "npx playwright test e2e/ideas.spec.ts (locked-rendering, flow,
// and modal cases)"). Real backend, not mocked JSON, at every layer this
// repo owns:
//
//   - ./support/intake-fixture.ts: a REAL local Postgres 16 database with
//     the REAL, unmodified `intake` schema migrations applied -- the II-1/
//     II-3 state-machine and immutability triggers, and the
//     mark_submitted_to_github RPC, all fire for real.
//   - ./support/handler-a-fixture.ts: the REAL services/llm-handler
//     orchestration code (src/server.ts's createHandler, unmodified),
//     running as a real local HTTP server against the fixture above.
//
// Only the genuinely external third party -- the real api.github.com --
// is a stand-in, exactly as services/llm-handler's own unit tests already
// draw that boundary. `page.route` acts as a thin same-origin reverse proxy
// forwarding the browser's real requests to these two real local servers
// (the same technique e2e/tools.spec.ts's mockRegistry already uses for the
// registry fixture), so the Shell's OWN code (src/lib/intake.ts,
// src/pages/ideas/*) runs entirely unmodified and unmocked too.
import { test, expect, type Page } from "@playwright/test";
import { mockAuth, fillAndSubmitLogin } from "./support/auth";
import { setupIntakeFixture, type IntakeFixture } from "./support/intake-fixture";
import { setupHandlerAFixture, type HandlerAFixture } from "./support/handler-a-fixture";

let intake: IntakeFixture;
let handlerA: HandlerAFixture;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  intake = await setupIntakeFixture();
  handlerA = await setupHandlerAFixture({ supabaseUrl: intake.shimBaseUrl, serviceRoleKey: intake.serviceRoleKey });
});

test.afterAll(() => {
  handlerA?.teardown();
  intake?.teardown();
});

const FORWARDED_HEADERS = ["apikey", "authorization", "accept-profile", "content-profile", "content-type", "prefer"];

function pickHeaders(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = all[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Forwards the browser's real `/rest/v1/idea` requests (src/lib/intake.ts's
 * postgrest() helper, and services/llm-handler's own reads, are never
 * touched) to the real Postgres-backed shim. */
async function mockIntakeRest(page: Page): Promise<void> {
  await page.route("**/rest/v1/idea**", async (route) => {
    const req = route.request();
    const search = new URL(req.url()).search;
    const res = await fetch(`${intake.shimBaseUrl}/rest/v1/idea${search}`, {
      method: req.method(),
      headers: pickHeaders(req.headers()),
      body: req.postData() ?? undefined,
    });
    const body = await res.text();
    await route.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body });
  });
}

/** Forwards the browser's real `POST /api/intake/submit` (src/lib/intake.ts's
 * submitIdea, via platformClient.fetch) to the REAL Handler A server. */
async function mockSubmitApi(page: Page): Promise<void> {
  await page.route("**/api/intake/submit", async (route) => {
    const req = route.request();
    const res = await fetch(`${handlerA.baseUrl}/api/intake/submit`, {
      method: req.method(),
      headers: pickHeaders(req.headers()),
      body: req.postData() ?? undefined,
    });
    const body = await res.text();
    await route.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body });
  });
}

async function signInAndGoTo(page: Page, path: string): Promise<void> {
  await mockAuth(page);
  await mockIntakeRest(page);
  await mockSubmitApi(page);
  await page.goto(path);
  await fillAndSubmitLogin(page);
  await page.waitForURL((url) => url.pathname === path);
}

test.describe("Locked rendering (II-3): a submitted idea is fully read-only", () => {
  test("the editor renders only the issue link and a disabled derivative action -- no save/promote/delete/submit", async ({
    page,
  }) => {
    const id = intake.seedSubmittedIdea({
      title: "Locked fixture idea",
      problem: "A problem that already shipped",
      outcome: "An outcome already delivered",
      targetRepo: "kgsmith19/hyperbolic-core",
      githubIssueNumber: 4242,
      githubIssueUrl: "https://github.com/kgsmith19/hyperbolic-core/issues/4242",
    });

    await signInAndGoTo(page, `/ideas/${id}`);

    await expect(page.getByTestId("idea-editor-page")).toBeVisible();
    await expect(page.getByText("Locked fixture idea")).toBeVisible();
    await expect(page.getByTestId("save-idea-button")).toHaveCount(0);
    await expect(page.getByTestId("promote-idea-button")).toHaveCount(0);
    await expect(page.getByTestId("delete-idea-button")).toHaveCount(0);
    await expect(page.getByTestId("submit-idea-button")).toHaveCount(0);
    const optimize = page.getByTestId("optimize-derivative-button");
    await expect(optimize).toBeDisabled();
    const issueLink = page.getByTestId("idea-issue-link");
    await expect(issueLink).toHaveAttribute("href", "https://github.com/kgsmith19/hyperbolic-core/issues/4242");
    await expect(issueLink).toContainText("#4242");
  });

  test("the list renders the same idea locked: plain-text title, no edit link, outbound issue link", async ({ page }) => {
    const id = intake.seedSubmittedIdea({
      title: "Locked list-row idea",
      problem: "p",
      outcome: "o",
      targetRepo: "kgsmith19/hyperbolic-core",
      githubIssueNumber: 4243,
      githubIssueUrl: "https://github.com/kgsmith19/hyperbolic-core/issues/4243",
    });

    await signInAndGoTo(page, "/ideas");

    const row = page.locator(`[data-testid="idea-row"][data-idea-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("idea-title-link")).toHaveCount(0);
    await expect(row.getByTestId("idea-title")).toHaveText("Locked list-row idea");
    const issueLink = row.getByTestId("idea-issue-link");
    await expect(issueLink).toHaveAttribute("href", "https://github.com/kgsmith19/hyperbolic-core/issues/4243");
  });
});

test.describe("The draft -> idea -> submitted flow, against the real schema and real Handler A orchestration", () => {
  test("create, promote, and submit -- the modal preview renders before any network call, then a real GitHub issue is created and the row locks", async ({
    page,
  }) => {
    const issuesBefore = handlerA.createdIssues.length;

    await signInAndGoTo(page, "/ideas/new");
    await page.getByTestId("idea-title-field").fill("E2E flow idea");
    await page.getByTestId("idea-problem-field").fill("A real problem, end to end");
    await page.getByTestId("idea-outcome-field").fill("A real outcome, end to end");
    await page.getByTestId("idea-notes-field").fill("Some notes");
    await page.getByTestId("save-idea-button").click();

    await page.waitForURL((url) => /^\/ideas\/[0-9a-f-]{36}$/.test(url.pathname));
    const ideaId = page.url().split("/ideas/")[1]!;
    expect(intake.readIdeaRow(ideaId)).toMatchObject({ status: "draft", title: "E2E flow idea" });

    await page.getByTestId("idea-target-repo-field").fill("kgsmith19/hyperbolic-core");
    await page.getByTestId("promote-idea-button").click();
    await expect(page.getByTestId("submit-idea-button")).toBeVisible();
    expect(intake.readIdeaRow(ideaId)).toMatchObject({ status: "idea", target_repo: "kgsmith19/hyperbolic-core" });

    await page.getByTestId("submit-idea-button").click();
    await expect(page.getByTestId("submit-confirmation-modal")).toBeVisible();
    await expect(page.getByTestId("submit-preview-title")).toHaveText("E2E flow idea");
    await expect(page.getByTestId("submit-preview-body")).toContainText("A real problem, end to end");
    await expect(page.getByTestId("submit-preview-labels")).toContainText("from-idea-intake");

    // The preview is client-rendered from the row already in hand -- proven
    // here, not assumed: no GitHub call and no DB status change have
    // happened yet, even though the modal is fully populated and visible.
    expect(handlerA.createdIssues.length).toBe(issuesBefore);
    expect(intake.readIdeaRow(ideaId)?.status).toBe("idea");

    await page.getByTestId("submit-confirm-button").click();

    await expect(page.getByTestId("submit-confirmation-modal")).toHaveCount(0);
    await expect(page.getByTestId("idea-issue-link")).toBeVisible();
    await expect(page.getByTestId("save-idea-button")).toHaveCount(0);

    expect(handlerA.createdIssues.length).toBe(issuesBefore + 1);
    const created = handlerA.createdIssues[handlerA.createdIssues.length - 1]!;
    expect(created.ownerRepo).toBe("kgsmith19/hyperbolic-core");
    expect(created.title).toBe("E2E flow idea");
    expect(created.labels).toEqual(["from-idea-intake"]);

    const row = intake.readIdeaRow(ideaId);
    expect(row).toMatchObject({
      status: "submitted_to_github",
      github_issue_number: created.number,
      github_issue_url: created.htmlUrl,
    });
    await expect(page.getByTestId("idea-issue-link")).toHaveAttribute("href", created.htmlUrl);
  });

  test("a derived idea's submission carries the 'derived' label and the 'Derived from' body line", async ({ page }) => {
    const parentId = intake.seedSubmittedIdea({
      title: "Parent idea",
      problem: "parent problem",
      outcome: "parent outcome",
      targetRepo: "kgsmith19/hyperbolic-core",
      githubIssueNumber: 4244,
      githubIssueUrl: "https://github.com/kgsmith19/hyperbolic-core/issues/4244",
    });
    // Derivatives can only be created against an already-submitted parent
    // (intake.guard_idea_insert, II-3) -- seeded directly via SQL since the
    // create-derivative UI itself is m4-06 scope, out of bounds for m3-07.
    const childId = intake.seedDraftDerivative(parentId, { title: "Derived idea", targetRepo: "kgsmith19/hyperbolic-core" });

    await signInAndGoTo(page, `/ideas/${childId}`);
    await page.getByTestId("promote-idea-button").click();
    await expect(page.getByTestId("submit-idea-button")).toBeVisible();

    await page.getByTestId("submit-idea-button").click();
    await expect(page.getByTestId("submit-preview-body")).toContainText(
      "Derived from: https://github.com/kgsmith19/hyperbolic-core/issues/4244"
    );
    await expect(page.getByTestId("submit-preview-labels")).toContainText("derived");

    await page.getByTestId("submit-confirm-button").click();
    await expect(page.getByTestId("idea-issue-link")).toBeVisible();

    const created = handlerA.createdIssues[handlerA.createdIssues.length - 1]!;
    expect(created.labels).toEqual(["from-idea-intake", "derived"]);
    expect(created.body).toContain("Derived from: https://github.com/kgsmith19/hyperbolic-core/issues/4244");
  });
});

test.describe("Deleting a draft (II-1: only draft/idea rows are deletable)", () => {
  test("delete removes the row for real and returns to the list", async ({ page }) => {
    await signInAndGoTo(page, "/ideas/new");
    await page.getByTestId("idea-title-field").fill("Idea to delete");
    await page.getByTestId("save-idea-button").click();
    await page.waitForURL((url) => /^\/ideas\/[0-9a-f-]{36}$/.test(url.pathname));
    const ideaId = page.url().split("/ideas/")[1]!;
    expect(intake.readIdeaRow(ideaId)).not.toBeNull();

    await page.getByTestId("delete-idea-button").click();
    await page.waitForURL((url) => url.pathname === "/ideas");
    expect(intake.readIdeaRow(ideaId)).toBeNull();
  });
});

test.describe("Latency budgets (05-h section 8: list p95 <= 300ms warm, editor save p95 <= 400ms)", () => {
  function p95(samples: number[]): number {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
  }

  test("list query: p95 <= 300ms over 50 calls from a warm client", async () => {
    const url = `${intake.shimBaseUrl}/rest/v1/idea?select=id,title,status,confidence,target_repo,updated_at&order=updated_at.desc`;
    // Warm-up call, excluded from the measured distribution (05-h section
    // 8's own "p95 warm" wording).
    await fetch(url);

    const samples: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const start = performance.now();
      await fetch(url);
      samples.push(performance.now() - start);
    }

    // eslint-disable-next-line no-console
    console.log(`[perf] idea list query over 50 calls (warm): p95=${p95(samples).toFixed(2)}ms max=${Math.max(...samples).toFixed(2)}ms`);
    expect(p95(samples)).toBeLessThanOrEqual(300);
  });

  test("editor save: p95 <= 400ms over repeated real PATCH round trips", async () => {
    const seedId = intake.seedDraftDerivative(null, { title: "Perf fixture idea", targetRepo: null });
    const url = `${intake.shimBaseUrl}/rest/v1/idea?id=eq.${seedId}&select=id,title,updated_at`;

    await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "warm-up" }) });

    const samples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const start = performance.now();
      await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `Perf fixture idea ${i}` }),
      });
      samples.push(performance.now() - start);
    }

    // eslint-disable-next-line no-console
    console.log(`[perf] editor save (PATCH) over 30 calls: p95=${p95(samples).toFixed(2)}ms max=${Math.max(...samples).toFixed(2)}ms`);
    expect(p95(samples)).toBeLessThanOrEqual(400);
  });
});
