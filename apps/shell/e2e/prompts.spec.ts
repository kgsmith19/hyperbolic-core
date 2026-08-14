// m5-01/m5-02 (docs/planning/issues/m5-01-feat-po-shell-contract.md,
// m5-02-feat-po-edit-usage-ui.md). Real backend, not mocked JSON:
// ./support/prompt-fixture.ts stands up a real local Postgres 16 database
// with the real, unmodified `prompt` schema migrations applied -- the
// record_version trigger fires for real on every body update, so a restore
// really does append a new version rather than rewriting history.
// `page.route` forwards the browser's real requests to that real local
// shim (the same technique e2e/tools.spec.ts's mockRegistry and
// e2e/ideas.spec.ts's mockIntakeRest already established), so
// src/lib/prompts.ts and src/pages/prompts/* run entirely unmodified.
import { test, expect, type Page } from "@playwright/test";
import { mockAuth, fillAndSubmitLogin } from "./support/auth";
import { setupPromptFixture, type PromptFixture } from "./support/prompt-fixture";

let fixture: PromptFixture;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = await setupPromptFixture();
});

test.afterAll(() => {
  fixture?.teardown();
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

const SHIMMED_PATHS = ["/rest/v1/prompt", "/rest/v1/prompt_version", "/rest/v1/tag", "/rest/v1/usage", "/rest/v1/configuration", "/rest/v1/rpc/log_run"];

async function mockPromptRest(page: Page): Promise<void> {
  for (const pathPrefix of SHIMMED_PATHS) {
    await page.route(`**${pathPrefix}**`, async (route) => {
      const req = route.request();
      const search = new URL(req.url()).search;
      const res = await fetch(`${fixture.shimBaseUrl}${pathPrefix}${search}`, {
        method: req.method(),
        headers: pickHeaders(req.headers()),
        body: req.postData() ?? undefined,
      });
      const body = await res.text();
      await route.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body });
    });
  }
}

async function signInAndGoTo(page: Page): Promise<void> {
  await mockAuth(page);
  await mockPromptRest(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/prompts");
  await fillAndSubmitLogin(page);
  await page.waitForURL((url) => url.pathname === "/prompts");
}

function cardFor(page: Page, id: string) {
  return page.locator(`[data-testid="prompt-card"][data-prompt-id="${id}"]`);
}

test.describe("Rename refusal (05-d section 5): namespaced vs legacy titles", () => {
  test("a namespaced title offers no Rename control", async ({ page }) => {
    const id = fixture.seedPrompt({ title: "brain/task-contract", body: "Do the thing." });
    await signInAndGoTo(page);

    const card = cardFor(page, id);
    await card.getByTestId("prompt-summary").click();
    await expect(card.getByTestId("edit-title-button")).toHaveCount(0);
    await expect(card.getByTestId("rename-refused-note")).toBeVisible();
  });

  test("a legacy (non-namespaced) title can really be renamed, PATCHed for real", async ({ page }) => {
    const id = fixture.seedPrompt({ title: "My legacy prompt", body: "Body text." });
    await signInAndGoTo(page);

    const card = cardFor(page, id);
    await card.getByTestId("prompt-summary").click();
    await card.getByTestId("edit-title-button").click();
    await card.getByTestId("title-field").fill("Renamed for real");
    await card.getByTestId("save-title-button").click();

    await expect(card.getByTestId("prompt-title")).toHaveText("Renamed for real");
    expect(fixture.readPromptRow(id)).toMatchObject({ title: "Renamed for real" });
  });
});

test.describe("Usage badge (05-d section 9 rank 1): matches a seeded usage count", () => {
  test("the badge shows exactly the seeded usage row count", async ({ page }) => {
    const id = fixture.seedPrompt({ title: "usage-badge-fixture", body: "Plain body, nothing to render." });
    fixture.seedUsage(id, 1, 4);
    await signInAndGoTo(page);

    await expect(cardFor(page, id).getByTestId("prompt-usage-badge")).toHaveText("4 uses");
  });

  test("copying a rendered prompt increments the badge by exactly one, via a real usage insert", async ({ page }) => {
    const id = fixture.seedPrompt({ title: "usage-increment-fixture", body: "Hi {{NAME}}." });
    fixture.seedUsage(id, 1, 2);
    await signInAndGoTo(page);

    const card = cardFor(page, id);
    await expect(card.getByTestId("prompt-usage-badge")).toHaveText("2 uses");
    await card.getByTestId("prompt-summary").click();
    await card.getByTestId("render-variable-NAME").fill("World");
    await card.getByTestId("render-preview-copy").click();

    await expect(card.getByTestId("prompt-usage-badge")).toHaveText("3 uses");
  });
});

test.describe("Render preview: token estimate labeled as an estimate (05-d section 9 rank 2)", () => {
  test("the preview shows the rendered text and a token count explicitly labeled '(estimate)'", async ({ page }) => {
    const id = fixture.seedPrompt({ title: "token-estimate-fixture", body: "Hello {{NAME}}, welcome." });
    await signInAndGoTo(page);

    const card = cardFor(page, id);
    await card.getByTestId("prompt-summary").click();
    await card.getByTestId("render-variable-NAME").fill("Operator");
    await card.getByTestId("render-preview-copy").click();

    await expect(card.getByTestId("render-status-copied")).toContainText("Hello Operator, welcome.");
    await expect(card.getByTestId("render-token-estimate")).toContainText("tokens (estimate)");

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe("Hello Operator, welcome.");
  });
});

test.describe("Body edit is real and versioned (m5-02)", () => {
  test("editing the body creates a real new version row, and restoring an older version is a new version too, never a history rewrite", async ({ page }) => {
    const id = fixture.seedPrompt({ title: "versioned-edit-fixture", body: "Version one body." });
    await signInAndGoTo(page);

    const card = cardFor(page, id);
    await card.getByTestId("prompt-summary").click();
    await card.getByTestId("edit-body-button").click();
    await card.getByTestId("body-field").fill("Version two body.");
    await card.getByTestId("save-body-button").click();
    await expect(card.getByTestId("prompt-body")).toHaveText("Version two body.");

    await card.getByText("Version history").click();
    await expect(card.getByTestId("version-row")).toHaveCount(2);
    const restoreV1 = card.getByTestId("restore-version-1");
    await expect(restoreV1).toBeVisible();
    await restoreV1.click();

    await expect(card.getByTestId("prompt-body")).toHaveText("Version one body.");
    // A real restore APPENDS version 3 (the record_version trigger fired
    // again); it does not rewrite version 1 or 2 out of history. The panel
    // is already open, so this is the version-history auto-refetch (keyed
    // on prompt.currentVersionNo) proving itself, not a fresh manual expand.
    await expect(card.getByTestId("version-row")).toHaveCount(3);
  });
});

test.describe("List: real seeded data, search and archived filtering", () => {
  test("search narrows to a real seeded prompt by title, and the archived toggle reveals a real archived one", async ({ page }) => {
    const activeId = fixture.seedPrompt({ title: "zzz-searchable-unique-title", body: "x" });
    const archivedId = fixture.seedPrompt({ title: "zzz-archived-unique-title", body: "x", isActive: false });
    await signInAndGoTo(page);

    await page.getByTestId("prompts-search").fill("zzz-searchable-unique");
    await expect(cardFor(page, activeId)).toBeVisible();
    await expect(cardFor(page, archivedId)).toHaveCount(0);

    await page.getByTestId("prompts-search").fill("zzz-archived-unique");
    await expect(cardFor(page, archivedId)).toHaveCount(0);
    await page.getByTestId("show-archived-toggle").click();
    await expect(cardFor(page, archivedId)).toBeVisible();
  });
});
