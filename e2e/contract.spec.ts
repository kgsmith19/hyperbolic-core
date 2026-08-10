// The contract suite (ADR-0006 in the ACC repo): every page round-trips
// through a REAL gui/server.mjs. If ACC's API contract (gui/README.md) drifts,
// this is what goes red. Sandbox only — see playwright.config.ts.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const dir = process.env.ACC_UI_E2E_DIR!;
const routeDir = path.join(dir, "code", "guards-target");
const dirsDir = path.join(dir, "runner", "directives");
const policyFile = path.join(dir, "policy.json");
const runnerCalls = () => {
  try {
    return fs.readFileSync(path.join(dir, "runner-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const liveIds = () => {
  try { return fs.readdirSync(dirsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")); }
  catch { return []; }
};

test.beforeEach(() => {
  fs.rmSync(dirsDir, { recursive: true, force: true });
  fs.rmSync(path.join(dir, "runner-calls.jsonl"), { force: true });
  fs.writeFileSync(policyFile, JSON.stringify({
    _comment: "ui e2e fixture",
    context: { softK: 400, hardK: 600 }, week: { amberTokens: 1e9, redTokens: 2e9 },
    review: { maxFinders: 3 }, subagents: { allow: ["Explore"] },
    profiles: { _note: "fixture", Normal: { label: "std" }, Heavy: { label: "big" } },
    lane: { slots: 1, minGapMs: 0 },
    kernel: {
      harness: "claude-code", budget: { wallClockMin: 60, toolCalls: 200, tokens: 500000 },
      hardCaps: { wallClockMin: 240 }, autonomy: { window: 10, rejectRate: 0.3, factor: 0.5, runs: 5 },
      checkpointMin: 20, alwaysAllowTools: ["TodoWrite"], extraDenyWriteRoots: [],
    },
    rates: { opus: { in: 15 } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, "guards-state.json"), JSON.stringify({
    enabled: true, secrets: [".env", "*.pem"], protected: ["C:/x"], projects: [],
    vaultKeys: ["EXISTING_KEY"], pending: [], trashed: [],
  }));
});

test("Start work: suggest fills the folder, GO creates + launches, Mark finished archives", async ({ page }) => {
  await page.goto("/");
  await page.locator("#task").fill("tighten the guards hook checks");
  await page.locator("#task").blur();
  await expect(page.locator("#cwd")).toHaveValue(routeDir);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "GO" }).click();
  await expect(page.getByTestId("note")).toContainText("launched d-");

  const ids = liveIds();
  expect(ids).toHaveLength(1);
  const stored = JSON.parse(fs.readFileSync(path.join(dirsDir, ids[0] + ".json"), "utf8"));
  expect(stored.text).toBe("tighten the guards hook checks");
  expect(stored.profile).toBe("Normal");
  await expect.poll(() => runnerCalls().length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(runnerCalls().at(-1)).toEqual([`directive:${ids[0]}`]);

  await expect(page.getByText(ids[0], { exact: true })).toBeVisible(); // the list row's id badge (the launch note also mentions the id, non-exactly)
  await page.getByRole("button", { name: "Mark finished" }).click();
  await expect(page.getByText("Nothing in flight.")).toBeVisible();
  expect(liveIds()).toHaveLength(0);
});

test("Start work: Guide appends a note to the log without touching status or restarting", async ({ page }) => {
  await page.goto("/");
  await page.locator("#task").fill("tighten the guards hook checks");
  await page.locator("#task").blur();
  await expect(page.locator("#cwd")).toHaveValue(routeDir);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "GO" }).click();
  await expect(page.getByTestId("note")).toContainText("launched d-");
  const ids = liveIds();
  expect(ids).toHaveLength(1);

  page.once("dialog", (d) => d.accept("focus on the retry path first, ignore the flaky one"));
  await page.getByRole("button", { name: "Guide" }).click();
  await expect.poll(() =>
    fs.readFileSync(path.join(dirsDir, ids[0] + ".log.md"), "utf8")
  ).toContain("focus on the retry path first, ignore the flaky one");
  expect(JSON.parse(fs.readFileSync(path.join(dirsDir, ids[0] + ".json"), "utf8")).status).toBe("active");
});

test("Guards: toggle round-trips through the real server into the engine's state", async ({ page }) => {
  await page.goto("/guards");
  await expect(page.getByText("ENABLED", { exact: true })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("DISABLED", { exact: true })).toBeVisible();
  expect(JSON.parse(fs.readFileSync(path.join(dir, "guards-state.json"), "utf8")).enabled).toBe(false);
});

test("Spending: tier renders; a dials save lands on disk and preserves unowned policy blocks", async ({ page }) => {
  await page.goto("/spending");
  await expect(page.getByTestId("tier")).toContainText("Getting expensive"); // fake usage says amber
  await expect(page.locator("#softK")).toHaveValue("400");
  const before = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  await page.locator("#softK").fill("350");
  await page.getByRole("button", { name: "Save my limits" }).click();
  await expect(page.getByTestId("dialsMsg")).toContainText("Saved");
  const after = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  expect(after.context.softK).toBe(350);
  expect(after.kernel).toEqual(before.kernel);
  expect(after._comment).toBe(before._comment);
});

test("Kernel: policy renders and a save lands on disk", async ({ page }) => {
  await page.goto("/kernel");
  await expect(page.locator("#toolCalls")).toHaveValue("200");
  await page.locator("#toolCalls").fill("150");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("kernelMsg")).toContainText("Saved");
  expect(JSON.parse(fs.readFileSync(policyFile, "utf8")).kernel.budget.toolCalls).toBe(150);
});

test("API unreachable: every page shows the error banner instead of blank UI", async ({ page }) => {
  // Intercept all /api/* requests and simulate network failure.
  await page.route("/api/**", (r) => r.abort("failed"));

  for (const route of ["/", "/guards", "/spending", "/kernel"]) {
    await page.goto(route);
    await expect(page.getByTestId("api-error")).toBeVisible();
  }
});
