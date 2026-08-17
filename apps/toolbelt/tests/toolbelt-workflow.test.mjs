import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The Toolbelt suite's steps live in a composite action, not in the
// workflow file: the pull_request path runs them as a native job in
// pr-verify.yml and the merge_group/push/workflow_dispatch path runs them
// from toolbelt-ci.yml, and both call this one action so the suite has
// exactly one source. The Playwright-runtime invariant below is therefore
// asserted against the action -- that is where the commands now are.
const TOOLBELT_ACTION = new URL(
  "../../../.github/actions/verify-tests-toolbelt/action.yml",
  import.meta.url,
);
const TOOLBELT_WORKFLOW = new URL(
  "../../../.github/workflows/toolbelt-ci.yml",
  import.meta.url,
);

test("browser journeys use the single root Playwright runtime", () => {
  const action = readFileSync(TOOLBELT_ACTION, "utf8");

  assert.match(
    action,
    /\.\/node_modules\/\.bin\/playwright install --with-deps chromium/,
  );
  assert.equal(
    action.match(/\.\/node_modules\/\.bin\/playwright test --config apps\/toolbelt\/apps\//g)?.length,
    2,
  );
  assert.match(action, /hashFiles\('package-lock\.json'\)/);
  assert.doesNotMatch(action, /npx playwright/);
  assert.doesNotMatch(action, /npm install[^\n]*@playwright\/test/);
});

test("the standalone Toolbelt workflow delegates to that one composite action", () => {
  const workflow = readFileSync(TOOLBELT_WORKFLOW, "utf8");

  // Pins the single-source-of-truth property itself: if the suite's steps
  // are ever inlined back into the workflow, they would escape the
  // Playwright-runtime assertions above, which read only the action.
  assert.match(workflow, /uses: \.\/\.github\/actions\/verify-tests-toolbelt/);
  assert.doesNotMatch(workflow, /playwright/i);
});
