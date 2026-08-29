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
const PR_VERIFY_WORKFLOW = new URL(
  "../../../.github/workflows/pr-verify.yml",
  import.meta.url,
);
const CRITICAL_BROWSER_FLOW = new URL(
  "../apps/prompt-organizer/frontend/e2e/critical-flow.test.mjs",
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

test("required Toolbelt browser verification is hermetic and credential-free", () => {
  const action = readFileSync(TOOLBELT_ACTION, "utf8");
  const standalone = readFileSync(TOOLBELT_WORKFLOW, "utf8");
  const prVerify = readFileSync(PR_VERIFY_WORKFLOW, "utf8");
  const browserFlow = readFileSync(CRITICAL_BROWSER_FLOW, "utf8");

  for (const requiredCi of [action, standalone, prVerify]) {
    assert.doesNotMatch(requiredCi, /owner_refresh_token/i);
    assert.doesNotMatch(requiredCi, /TOOLBELT_OWNER_REFRESH_TOKEN/);
    assert.doesNotMatch(requiredCi, /export-owner-session\.mjs/);
  }

  // The critical journey still runs as a browser E2E, but every Supabase REST
  // request must be intercepted locally rather than mutating the hosted owner
  // account. The literal is intentionally structural: removing the route
  // fixture would make the required PR lane network-dependent again.
  assert.match(browserFlow, /page\.route\([\s\S]*\/rest\/v1\//);
  assert.doesNotMatch(browserFlow, /TOOLBELT_OWNER_TOKEN/);
  assert.doesNotMatch(browserFlow, /await login\(/);
});
