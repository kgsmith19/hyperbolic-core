import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
const DEPLOYED_CONTRACT_WORKFLOW = new URL(
  "../../../.github/workflows/platform-contract.yml",
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

  assert.match(workflow, /uses: \.\/\.github\/actions\/verify-tests-toolbelt/);
  assert.doesNotMatch(workflow, /playwright/i);
});

test("required Toolbelt browser verification is hermetic and has no hosted credential dependency", () => {
  const action = readFileSync(TOOLBELT_ACTION, "utf8");
  const standalone = readFileSync(TOOLBELT_WORKFLOW, "utf8");
  const prVerify = readFileSync(PR_VERIFY_WORKFLOW, "utf8");
  const deployedContract = readFileSync(DEPLOYED_CONTRACT_WORKFLOW, "utf8");
  const browserFlow = readFileSync(CRITICAL_BROWSER_FLOW, "utf8");

  // The executable Toolbelt suite and its standalone caller consume no owner
  // credential and perform no hosted Auth exchange. A caller passing an
  // undeclared legacy input cannot affect this composite action's behavior;
  // its removal is metadata cleanup, not a correctness prerequisite.
  for (const requiredCi of [action, standalone]) {
    assert.doesNotMatch(requiredCi, /owner_refresh_token/i);
    assert.doesNotMatch(requiredCi, /TOOLBELT_OWNER_REFRESH_TOKEN/);
    assert.doesNotMatch(requiredCi, /export-owner-session\.mjs/);
  }
  assert.doesNotMatch(action, /owner-session\.test\.mjs/);

  // PR-time verification still delegates to the same credential-free action;
  // it must not inline a second auth/browser implementation.
  assert.match(prVerify, /uses: \.\/\.github\/actions\/verify-tests-toolbelt/);
  assert.doesNotMatch(prVerify, /export-owner-session\.mjs/);

  // The real hosted environment proof remains explicitly separate/manual.
  assert.match(deployedContract, /workflow_dispatch/);
  assert.match(deployedContract, /Verify live Supabase contract/);

  // The critical journey still runs as a browser E2E, but every Supabase REST
  // request is intercepted locally rather than mutating the hosted owner
  // account. The fixture enforces an exact bearer token at the API boundary.
  assert.match(browserFlow, /page\.route\([\s\S]*\/rest\/v1\//);
  assert.match(browserFlow, /authorization !== `Bearer \$\{expectedToken\}`/);
  assert.doesNotMatch(browserFlow, /TOOLBELT_OWNER_TOKEN/);
  assert.doesNotMatch(browserFlow, /await login\(/);
});
