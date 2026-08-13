import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const TOOLBELT_WORKFLOW = new URL(
  "../../../.github/workflows/toolbelt-ci.yml",
  import.meta.url,
);

test("browser journeys use the single root Playwright runtime", () => {
  const workflow = readFileSync(TOOLBELT_WORKFLOW, "utf8");

  assert.match(
    workflow,
    /\.\/node_modules\/\.bin\/playwright install --with-deps chromium/,
  );
  assert.equal(
    workflow.match(/\.\/node_modules\/\.bin\/playwright test --config apps\/toolbelt\/apps\//g)?.length,
    2,
  );
  assert.match(workflow, /hashFiles\('package-lock\.json'\)/);
  assert.doesNotMatch(workflow, /npx playwright/);
  assert.doesNotMatch(workflow, /npm install[^\n]*@playwright\/test/);
});
