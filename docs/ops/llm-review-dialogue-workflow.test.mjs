// Structural + behavioral assertions over the LLM Review dialogue machinery:
// .github/workflows/llm-review-dialogue.yml, .github/workflows/dev-agent-dispatch.yml,
// .github/workflows/llm-review-recheck.yml, and the artifact-staging steps in
// .github/actions/verify-llm-review/action.yml.
//
// Issue #231. This closes the gap AGENTS.md used to name explicitly:
// "Posting findings into the PR discussion itself, with a round counter and
// owner escalation after repeated unresolved rounds ... is tracked
// separately and is not yet implemented." Three invariants make this a
// multi-workflow design rather than one, and getting any of them wrong is a
// security bug, not a style issue:
//
//   1. ai-review (pr-verify.yml) and llm-review-recheck.yml both execute
//      pull-request-authored code while holding a provider credential, so
//      neither may EVER hold a token that can write to the pull request --
//      unaffected by ai-review also being a mandatory needs: dependency of
//      PR Gate (#232): "required in substance" says nothing about which job
//      is safe to trust with write access.
//   2. The posting job (llm-review-dialogue.yml) holds pull-requests: write,
//      so it must NEVER check out or execute repository content -- same
//      discipline as pr-verify.yml's own "PR Gate".
//   3. No new workflow may add a pull-request check row -- workflow_run and
//      repository_dispatch report none, which is exactly why they were
//      chosen over a new job in pr-verify.yml. llm-review-recheck.yml
//      (Issue #262's follow-on slice 8) reuses the same repository_dispatch
//      mechanism dev-agent-dispatch.yml itself uses, for the same reason:
//      a comment posted with GITHUB_TOKEN cannot retrigger a pull_request
//      workflow, and repository_dispatch is one of the two documented
//      exceptions.
//
// The behavioral tests extract the real embedded scripts and execute them
// against a mocked GitHub API, for the same reason pr-verify-workflow.test.mjs
// does: a structural grep cannot tell a real SHA-mismatch guard from one
// whose `if` was quietly deleted.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The extracted scripts use CommonJS `require("node:fs")` / `require("node:path")`
// (that is what actions/github-script's own sandbox provides), so this ESM
// test file must hand them a real `require` explicitly -- it is not a global here.
const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dialoguePath = path.join(root, ".github/workflows/llm-review-dialogue.yml");
const dispatchPath = path.join(root, ".github/workflows/dev-agent-dispatch.yml");
const recheckPath = path.join(root, ".github/workflows/llm-review-recheck.yml");
const reviewActionPath = path.join(root, ".github/actions/verify-llm-review/action.yml");
const runbookPath = path.join(root, "docs/ops/runbook.md");
const dialogueYaml = readFileSync(dialoguePath, "utf8");
const dispatchYaml = readFileSync(dispatchPath, "utf8");
const recheckYaml = readFileSync(recheckPath, "utf8");
const reviewActionYaml = readFileSync(reviewActionPath, "utf8");
const runbook = readFileSync(runbookPath, "utf8");

// Issue #355's own oracles read dev-agent-dispatch.yml through a
// line-ending-normalized copy. `core.autocrlf=true` is the default on
// Windows, so the same committed LF file is CRLF in a Windows working tree,
// and a locator like `indexOf("id: pr\n")` then finds nothing -- which is
// indistinguishable from the step having been deleted. That is a silently
// passing security oracle on one platform and a failing one on the other, so
// the containment assertions below normalize rather than skip. Line endings
// are not part of any claim any of them makes.
const dispatchYamlLf = dispatchYaml.replace(/\r\n/g, "\n");

// Issue #304: provider-company separation is a credential boundary, not only
// a model-dispatch check. The action must execute packages/review's canonical
// validator before Infisical imports the selected reviewer credential.
//
// Owner directive (2026-08-26): every provider value this action uses comes
// from repository variables (vars.DEV_PROVIDER via inputs.review_builder_provider),
// never parsed out of agent-roles.yaml directly -- an earlier revision added
// a step reading agent-roles.yaml via the API, which the owner overruled as
// premature for this repo's current early stage.
test("AI Review validates provider-company separation before reading credentials", () => {
  const setupNode = reviewActionYaml.indexOf("- name: Setup · Install Node");
  const preflight = reviewActionYaml.indexOf("- name: Preflight · Verify the reviewer is configured");
  const credentials = reviewActionYaml.indexOf("- name: Setup · Pull reviewer credentials from Infisical");

  assert.ok(setupNode >= 0, "verify-llm-review/action.yml: Node setup step not found");
  assert.ok(preflight >= 0, "verify-llm-review/action.yml: reviewer preflight step not found");
  assert.ok(credentials >= 0, "verify-llm-review/action.yml: Infisical credential step not found");
  assert.ok(setupNode < preflight, "Node setup must precede the reviewer preflight");
  assert.ok(preflight < credentials, "provider separation must pass before credentials are read");

  const preflightBlock = stepBlock(reviewActionYaml, PREFLIGHT_STEP);
  // The preflight now calls a checked-in producer rather than an inline
  // heredoc, so the claim is asserted where it moved to: whatever script the
  // action names must be the one importing the canonical validator. Following
  // the action's own reference rather than a hardcoded path is what keeps a
  // rename in either file from quietly detaching this oracle.
  const producerPath = producerCommandLine().match(/packages\/review\/bin\/[\w.-]+\.mjs/)?.[0];
  assert.ok(producerPath, "the preflight must invoke a checked-in provenance producer");
  assert.match(
    readFileSync(path.join(root, producerPath), "utf8"),
    /import \{ resolveConfig \} from ["']\.\.\/src\/config\.ts["']/,
    "the preflight's producer must reuse packages/review's company-aware validator"
  );
  assert.doesNotMatch(
    preflightBlock,
    /\[ "\$reviewer" = "\$builder" \]/,
    "a raw-string equality check cannot enforce the Google/Gemini collision"
  );
  assert.match(
    preflightBlock,
    /REVIEW_BUILDER_PROVIDER:\s*\$\{\{ inputs\.review_builder_provider \}\}/,
    "the runtime validator must receive vars.DEV_PROVIDER via the input"
  );
});

// The builder half of the credential boundary (Issue #354). The test above
// pins the ORDER of the steps; these pin what the first one actually refuses,
// by running the real shell the action runs.
//
// A structural grep cannot tell a live `[ -n "$REVIEW_BUILDER_PROVIDER" ]`
// guard from one whose line was deleted, and the failure it would miss is the
// silent one: an empty builder variable that reaches Infisical, mints a
// reviewer credential, and calls a model to review a change whose author was
// never stated. So the step's own `run:` body is extracted and executed.
//
// Git Bash is not always on PATH for the process that launched node on
// Windows, so it is discovered rather than assumed. A miss fails the test that
// needs it, naming what was tried -- never a skip, which would silently turn
// every shell-boundary oracle in this file into a no-op.
let discoveredBash;
function bash() {
  const candidates = ["bash", "C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"];
  if (discoveredBash === undefined) {
    discoveredBash =
      candidates.find((candidate) => {
        const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
        return probe.error === undefined && probe.status === 0;
      }) ?? null;
  }
  assert.ok(discoveredBash !== null, `no usable bash found; tried: ${candidates.join(", ")}`);
  return discoveredBash;
}

// `npm` and `npx` are stubbed as shell FUNCTIONS sourced ahead of the script
// rather than as PATH entries: a function shadows the real binary inside the
// very shell that runs the step's unmodified text, and it sidesteps the MSYS
// PATH rewriting that makes a PATH-based stub unreliable on Windows. They are
// the first two things the step does once its variable check passes, so
// "neither marker exists" is a direct, checkable proxy for "nothing
// downstream ran" -- the Infisical import and the model call are both strictly
// later than the `npx` line.
function runPreflightStep(stepEnv) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "issue-354-preflight-"));
  const scriptPath = path.join(dir, "preflight.sh");
  const wrapperPath = path.join(dir, "wrapper.sh");
  const npmMarker = path.join(dir, "npm-was-called");
  const npxMarker = path.join(dir, "npx-was-called");

  writeFileSync(scriptPath, extractStepShell(reviewActionYaml, PREFLIGHT_STEP), "utf8");
  writeFileSync(
    wrapperPath,
    ['npm() { : > "$NPM_MARKER"; }', 'npx() { : > "$NPX_MARKER"; }', '. "$PREFLIGHT_SCRIPT"', ""].join("\n"),
    "utf8"
  );

  const result = spawnSync(bash(), [wrapperPath], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NPM_MARKER: npmMarker,
      NPX_MARKER: npxMarker,
      PREFLIGHT_SCRIPT: scriptPath,
      ...stepEnv,
    },
  });

  const observed = {
    status: result.status,
    stdout: result.stdout ?? "",
    // `result.error` is folded in so a shell that never started (no bash on
    // PATH) reports THAT, rather than an assertion about an empty stderr and a
    // null status that reads like the guard misbehaved.
    stderr: result.error ? `${result.error.message}\n${result.stderr ?? ""}` : (result.stderr ?? ""),
    npmCalled: existsSync(npmMarker),
    npxCalled: existsSync(npxMarker),
  };
  rmSync(dir, { recursive: true, force: true });
  return observed;
}

// The six repository variables the step reads, all present. Individual tests
// blank out the ones under test.
const PROVISIONED_PREFLIGHT_ENV = {
  // Always set on a GitHub-hosted runner, and the producer command expands it,
  // so `set -u` makes its absence an error rather than an empty path.
  RUNNER_TEMP: os.tmpdir(),
  IDENTITY_ID: "an-infisical-identity",
  PROJECT_SLUG: "a-project-slug",
  REVIEW_PROVIDER: "openai",
  REVIEW_MODEL: "gpt-5-mini",
  REVIEW_BUILDER_PROVIDER: "anthropic",
  DEV_MODEL: "claude-opus-5",
};

test("AI Review refuses a missing builder provider or model before importing any credential", () => {
  // The wiring oracle first: executing the step with an env this test invents
  // would prove nothing if the action never passed those values in.
  const preflightBlock = stepBlock(reviewActionYaml, PREFLIGHT_STEP);
  assert.match(
    preflightBlock,
    /DEV_MODEL:\s*\$\{\{ inputs\.dev_model \}\}/,
    "the preflight must receive vars.DEV_MODEL via the input"
  );

  // Empty AND whitespace-only, for both variables. A bare `[ -n "$X" ]` passes
  // a value of " ", so the run would proceed through `npm ci` and the
  // canonical validator before failing -- the right verdict reached by
  // spending the exact downstream commands this step exists to prevent. A CI
  // expression is precisely where a whitespace-only value comes from, so the
  // shell boundary has to agree with the contract the step's own message
  // states.
  for (const [blanked, expectedVariable] of [
    ["REVIEW_BUILDER_PROVIDER", "vars.DEV_PROVIDER"],
    ["DEV_MODEL", "vars.DEV_MODEL"],
  ]) {
    for (const blank of ["", " ", "\t", "  \t  "]) {
      const shown = `${blanked}=${JSON.stringify(blank)}`;
      const observed = runPreflightStep({ ...PROVISIONED_PREFLIGHT_ENV, [blanked]: blank });

      assert.equal(observed.status, 1, `${shown} must fail the step: ${observed.stderr}`);
      assert.match(
        observed.stderr,
        new RegExp(expectedVariable.replace(".", "\\.")),
        `${shown} must name ${expectedVariable}, the variable the owner has to set`
      );
      assert.equal(observed.npmCalled, false, `no dependency install may run for ${shown}`);
      assert.equal(observed.npxCalled, false, `no downstream call may run for ${shown}`);
    }
  }
});

// Positive control for the test above. Without it "the markers are absent"
// could just as easily mean the stubs were never reachable at all, which would
// make every assertion above vacuously true.
test("AI Review preflight proceeds past the variable check once every builder variable is set", () => {
  const observed = runPreflightStep(PROVISIONED_PREFLIGHT_ENV);

  assert.equal(observed.status, 0, `a fully provisioned preflight must pass: ${observed.stderr}`);
  assert.equal(observed.npmCalled, true, "the provisioned path must reach the dependency install");
  assert.equal(observed.npxCalled, true, "the provisioned path must reach the canonical validator");
});

// Issue #354 follow-up: durable provenance. The preflight already resolves the
// canonical config; these prove the RESOLVED values survive into the artifact
// the dialogue workflow reads, rather than dying with the job's log.
//
// The staging step is executed for real, exactly as extracted, so a test
// cannot pass against a step that merely mentions the fields in a comment.
function runStagingStep({ files, stepEnv, runnerTemp }) {
  const dir = runnerTemp ?? mkdtempSync(path.join(os.tmpdir(), "issue-354-staging-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  }

  const scriptPath = path.join(dir, "stage.sh");
  writeFileSync(scriptPath, extractStepShell(reviewActionYaml, "Review · Stage the verdict for the dialogue workflow"), "utf8");

  const result = spawnSync(bash(), [scriptPath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, RUNNER_TEMP: dir, ...stepEnv },
  });

  const metaPath = path.join(dir, "llm-review-artifact", "review-meta.json");
  const observed = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? `${result.error.message}\n${result.stderr ?? ""}` : (result.stderr ?? ""),
    meta: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null,
  };
  if (runnerTemp === undefined) rmSync(dir, { recursive: true, force: true });
  return observed;
}

const STAGING_ENV = {
  PR_NUMBER: "354",
  BASE_SHA: "b".repeat(40),
  HEAD_SHA: "h".repeat(40),
  REVIEW_OUTCOME: "success",
};

// The resolved config's builder model is opaque provenance, so the sentinel is
// padded and mixed-case end to end: any producer or staging step that trims,
// lowercases, or re-derives the value from a shell variable fails here.
const PRODUCER_ENV = {
  REVIEW_PROVIDER: "openai",
  REVIEW_MODEL: "gpt-5-mini",
  REVIEW_BUILDER_PROVIDER: "ANTHROPIC",
  DEV_MODEL: "  Claude-OPUS-5.1@2026-08\t",
};

const RESOLVED_PROVENANCE_KEYS = ["builderModel", "builderProvider", "reviewerModel", "reviewerProvider"];

// The producer is located BY READING THE ACTION, not by hardcoding a path
// here. That is the whole point: a test that names the script itself stays
// green when the action stops calling it, and a test that stubs the runtime
// stays green when the script is deleted. Reading the command the action
// actually runs makes both of those a failure.
function producerCommandLine() {
  const line = stepBlock(reviewActionYaml, PREFLIGHT_STEP)
    .split("\n")
    .map((raw) => raw.replace(/\r$/, "").trim())
    .find((raw) => !raw.startsWith("#") && raw.includes("review-config.json"));
  assert.ok(line, "the preflight must run a command that produces review-config.json");
  return line;
}

test("the action's provenance producer is a real script the action actually invokes", () => {
  const command = producerCommandLine();
  const scriptPath = command.match(/packages\/review\/bin\/[\w.-]+\.mjs/)?.[0];
  assert.ok(
    scriptPath,
    `the preflight must invoke a checked-in producer script, not an inline heredoc: ${command}`
  );
  assert.ok(
    existsSync(path.join(root, scriptPath)),
    `${scriptPath} is named by verify-llm-review/action.yml but does not exist on disk`
  );
});

// Runs the producer exactly as the action runs it -- same command line, same
// runtime -- into a real RUNNER_TEMP, then runs the real staging step over that
// same directory. Nothing is hand-seeded, so deleting or renaming the producer,
// changing its key names, or breaking either half of the seam fails here.
function runProducer(runnerTemp, producerEnv) {
  return spawnSync(bash(), ["-c", producerCommandLine()], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, RUNNER_TEMP: runnerTemp, ...producerEnv },
  });
}

test("producer to artifact: the resolved config reaches review-meta.json with exact keys, byte for byte", () => {
  const runnerTemp = mkdtempSync(path.join(os.tmpdir(), "issue-354-seam-"));
  try {
    const produced = runProducer(runnerTemp, PRODUCER_ENV);
    assert.equal(produced.status, 0, `the producer must succeed: ${produced.stderr}`);

    const configPath = path.join(runnerTemp, "review-config.json");
    assert.ok(existsSync(configPath), "the producer must write review-config.json where the action names it");

    const staged = runStagingStep({
      runnerTemp,
      files: { "review-verdict.json": { verdict: "pass" } },
      stepEnv: STAGING_ENV,
    });
    assert.equal(staged.status, 0, `the staging step must succeed: ${staged.stderr}`);

    assert.deepEqual(
      Object.keys(staged.meta.provenance).sort(),
      RESOLVED_PROVENANCE_KEYS,
      "exactly the four resolved fields, no more and no fewer"
    );
    assert.deepEqual(staged.meta.provenance, {
      reviewerProvider: "openai",
      reviewerModel: "gpt-5-mini",
      builderProvider: "anthropic",
      builderModel: PRODUCER_ENV.DEV_MODEL,
    });
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

// Fail closed, and VISIBLY. A verdict was produced but its provenance is
// missing or unreadable: the run judged something and cannot say with what.
// That must be said out loud, and it must not become a gate failure -- the
// findings still have to reach the pull request.
test("a verdict with no readable provenance stages null and warns, without failing the step", () => {
  for (const [label, files] of [
    ["absent", { "review-verdict.json": { verdict: "pass" } }],
    ["malformed", { "review-verdict.json": { verdict: "pass" }, "review-config.json": "{ not json" }],
  ]) {
    const observed = runStagingStep({ files, stepEnv: STAGING_ENV });

    assert.equal(observed.status, 0, `${label} provenance must not fail the step: ${observed.stderr}`);
    assert.equal(observed.meta?.verdictPresent, true, `${label}: the verdict is still staged`);
    assert.equal(observed.meta?.provenance, null, `${label} provenance must be null, never invented`);
    assert.match(
      `${observed.stdout}${observed.stderr}`,
      /::warning::/,
      `${label} provenance must be announced, not swallowed`
    );
  }
});

// The discriminating control for the warning above: when no verdict was
// produced at all, absent provenance is the expected, unremarkable state --
// the review did not run. Warning there would train readers to ignore it.
test("a run that produced no verdict stages absent provenance without a warning", () => {
  const observed = runStagingStep({ files: {}, stepEnv: { ...STAGING_ENV, REVIEW_OUTCOME: "failure" } });

  assert.equal(observed.status, 0, `staging must still run after a failed review: ${observed.stderr}`);
  assert.equal(observed.meta?.verdictPresent, false, "no verdict file means no verdict");
  assert.equal(observed.meta?.provenance, null, "absent provenance must be null, not invented");
  assert.doesNotMatch(
    `${observed.stdout}${observed.stderr}`,
    /::warning::/,
    "no verdict means absent provenance is expected, not noteworthy"
  );
});

// The reviewer step runs packages/review's CLI, which resolves the SAME config
// the preflight validated. A builder variable checked in the preflight but
// never exported to the CLI would fail the real run at the point where a
// provider credential is already in the environment -- the preflight exists
// precisely so that cannot happen.
test("the model call receives the builder model, not only the builder provider", () => {
  const reviewBlock = stepBlock(reviewActionYaml, "Review · Run the adversarial LLM reviewer");

  assert.match(
    reviewBlock,
    /REVIEW_BUILDER_PROVIDER:\s*\$\{\{ inputs\.review_builder_provider \}\}/,
    "the model call must receive the builder provider"
  );
  assert.match(
    reviewBlock,
    /DEV_MODEL:\s*\$\{\{ inputs\.dev_model \}\}/,
    "the model call must receive the builder model too"
  );
});

test("runbook pins the reviewer and developer identities to their exact OIDC subject sets", () => {
  // These are deliberately repository-specific, immutable GitHub OIDC IDs,
  // captured by the live run linked in the runbook. A fork should fail this
  // repository-policy test until its owner records that fork's own prefix;
  // silently deriving names would weaken the rename-resistant trust lock.
  const immutablePrefix = "repo:kgsmith19@64936641/hyperbolic-core@1331401739:";

  assert.match(
    runbook,
    new RegExp(`${immutablePrefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\{pull_request,ref:refs/heads/main\\}`),
    "the reviewer must trust the PR token and the main-ref token used by its non-PR workflows"
  );
  assert.match(
    runbook,
    new RegExp(`${immutablePrefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}ref:refs/heads/main`),
    "the developer must trust only the main-ref token used by repository/workflow dispatch"
  );
  assert.doesNotMatch(runbook, /\.\.\.:workflow_run|\.\.\.:repository_dispatch|\.\.\.:workflow_dispatch/);
});

test("the temporary OIDC claim diagnostic is removed after live subject confirmation", () => {
  assert.doesNotMatch(dialogueYaml, /DEBUG · Print this job's OIDC subject claim/);
  assert.doesNotMatch(dialogueYaml, /core\.getIDToken\(\)/);
});

// General indentation-bounded YAML block-scalar extractor. Unlike
// pr-verify-workflow.test.mjs's version, this does not assume the block is the
// last thing in the file -- dev-agent-dispatch.yml's script step is followed by
// a checkout and an action step -- so it stops at the first line whose
// indentation drops below the block's own, which is exactly what ends a YAML
// block scalar.
//
// `marker` is the block header being opened (`script: |` for an
// actions/github-script step, `run: |` for a shell step): the two kinds of
// block are bounded identically, and one implementation is one place for that
// rule to be right.
//
// `stripCarriageReturns` is opt-in and exists for one caller: a block that is
// handed to `bash` for real execution, which will not run a script whose lines
// end in a carriage return on this repository's CRLF Windows checkout. It is
// deliberately NOT the default -- the `script: |` callers below are pinned to
// their current behavior, and quietly changing it here would be a repair of
// unrelated CRLF debt smuggled in as a refactor.
function extractIndentedBlock(yamlText, marker, fromIndex = 0, { stripCarriageReturns = false } = {}) {
  const markerIndex = yamlText.indexOf(marker, fromIndex);
  assert.ok(markerIndex >= 0, `no \`${marker}\` block found`);
  const afterMarker = yamlText.slice(markerIndex + marker.length);
  const lines = afterMarker
    .split("\n")
    .slice(1)
    .map((line) => (stripCarriageReturns ? line.replace(/\r$/, "") : line));

  let blockIndent = null;
  const collected = [];
  for (const line of lines) {
    if (line.trim() === "") {
      collected.push(line);
      continue;
    }
    const indent = line.match(/^ */)[0].length;
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) break;
    collected.push(line);
  }
  assert.ok(blockIndent !== null, `the \`${marker}\` block at ${markerIndex} is empty`);

  return collected.map((line) => (line.trim() === "" ? "" : line.slice(blockIndent))).join("\n");
}

function extractScript(yamlText, fromIndex = 0) {
  return extractIndentedBlock(yamlText, "script: |", fromIndex);
}

// One named composite-action step, start to just before the next step.
function stepBlock(yamlText, stepName) {
  const start = yamlText.indexOf(`- name: ${stepName}`);
  assert.ok(start >= 0, `verify-llm-review/action.yml: step "${stepName}" not found`);
  const end = yamlText.indexOf("\n    - name:", start + 1);
  return yamlText.slice(start, end < 0 ? undefined : end);
}

// The `run: |` body of a named composite-action step, ready to hand to bash.
function extractStepShell(yamlText, stepName) {
  return `${extractIndentedBlock(stepBlock(yamlText, stepName), "run: |", 0, { stripCarriageReturns: true })}\n`;
}

const PREFLIGHT_STEP = "Preflight · Verify the reviewer is configured";

// Wrapped exactly the way actions/github-script actually invokes a script:
// as an AsyncFunction body, so a bare top-level `return` and `await` are both
// legal -- the same technique pr-verify-workflow.test.mjs's
// loadAllGatesModule uses for the All Gates script.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadDialogueScript() {
  // Anchored rather than defaulting to the first `script: |` block in the
  // file: a temporary OIDC-subject debug step (see llm-review-dialogue.yml's
  // own header comment on it) now runs earlier in the job and has a
  // `script: |` block of its own, which a bare fromIndex=0 search would grab
  // instead of the real posting script.
  const marker = dialogueYaml.indexOf("Dialogue · Post findings");
  assert.ok(marker >= 0, "llm-review-dialogue.yml: posting step not found");
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(dialogueYaml, marker));
}

const VALIDATION_STEP = "Preflight · Validate dispatch, dev role, and exact PR head";
const CREDENTIAL_STEP = "Preflight · Confirm the dev agent's credentials are provisioned";

// Issue #355 splits what used to be one "resolve the provider and check its
// credential" preflight into two steps either side of the Infisical pull:
// this one runs FIRST, with no secret in scope at all, and decides whether
// the dispatch is eligible to reach a credential in the first place.
function loadValidationScript() {
  const marker = dispatchYamlLf.indexOf(VALIDATION_STEP);
  assert.ok(marker >= 0, `dev-agent-dispatch.yml: step "${VALIDATION_STEP}" not found`);
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(dispatchYamlLf, marker));
}

// The credential half of the split above -- runs only after eligibility, and
// only after the Infisical pull has put the secrets in scope.
function loadCredentialPreflightScript() {
  const marker = dispatchYamlLf.indexOf(CREDENTIAL_STEP);
  assert.ok(marker >= 0, `dev-agent-dispatch.yml: step "${CREDENTIAL_STEP}" not found`);
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(dispatchYamlLf, marker));
}

// dev-agent-dispatch.yml's LAST script: | block (Issue #262's follow-on
// slice 8) -- fires llm-review-recheck for a PR the agent replied to
// without pushing. Located by its own step name, same as every other
// multi-block extractor in this file.
function loadRecheckFireScript() {
  const marker = dispatchYamlLf.indexOf("Recheck · Fire a recheck if the agent replied without pushing a commit");
  assert.ok(marker >= 0, "dev-agent-dispatch.yml: recheck-fire step not found");
  return new AsyncFunction("context", "core", "github", "process", extractScript(dispatchYamlLf, marker));
}

// llm-review-recheck.yml's own staleness guard -- the FIRST (and only)
// script: | block in that file, mirroring loadDispatchPrCheckScript()'s
// shape for dev-agent-dispatch.yml's own PR-check step.
function loadRecheckContextScript() {
  const marker = recheckYaml.indexOf("Context · Resolve the pull request, and stop if it moved on");
  assert.ok(marker >= 0, "llm-review-recheck.yml: context step not found");
  return new AsyncFunction("context", "core", "github", "process", extractScript(recheckYaml, marker));
}

// The conversation step is the SECOND script: | block in this file (after
// the Issue-body step), so it needs a starting index -- the same reason
// loadDispatchPrCheckScript() above locates its block by a step id first.
function loadConversationScript() {
  const marker = reviewActionYaml.indexOf("Context · Write the pull request's conversation to a file");
  assert.ok(marker >= 0, "verify-llm-review/action.yml: conversation step not found");
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(reviewActionYaml, marker));
}

// The Issue-and-PR-body step is the FIRST script: | block in this file, so
// no starting index is needed -- extractScript's default fromIndex finds it.
function loadIssueAndPrBodyScript() {
  const marker = reviewActionYaml.indexOf("Context · Write the linked Issue body and the pull request body to files");
  assert.ok(marker >= 0, "verify-llm-review/action.yml: Issue-and-PR-body step not found");
  return new AsyncFunction("require", "context", "core", "github", "process", extractScript(reviewActionYaml, marker));
}

// ---------------------------------------------------------------------------
// Structural: the token-placement invariant, mechanically enforced the same
// way docs/ops/pr-verify-workflow.test.mjs enforces it for All Gates.
// ---------------------------------------------------------------------------

// Scoped to each file's actual `permissions:` block(s), not the whole file --
// llm-review.yml's own header comment quotes "pull-requests: write" in prose
// to explain why it is deliberately absent, and a whole-file grep would
// wrongly flag that explanation as the grant it is warning against.
function permissionsBlocks(text) {
  const blocks = [];
  const pattern = /\n(\s*)permissions:\n/g;
  for (const match of text.matchAll(pattern)) {
    const indent = match[1].length;
    const start = match.index + match[0].length;
    const lines = text.slice(start).split("\n");
    const collected = [];
    for (const line of lines) {
      if (line.trim() === "") {
        collected.push(line);
        continue;
      }
      const lineIndent = line.match(/^ */)[0].length;
      if (lineIndent <= indent) break;
      collected.push(line);
    }
    blocks.push(collected.join("\n"));
  }
  return blocks;
}

test("ai-review stays read-only: no pull-requests write in any permissions block reachable by it", () => {
  const reviewWorkflow = readFileSync(path.join(root, ".github/workflows/llm-review.yml"), "utf8");
  const prVerify = readFileSync(path.join(root, ".github/workflows/pr-verify.yml"), "utf8");
  const jobStart = prVerify.indexOf("\n  ai-review:");
  const jobEnd = prVerify.indexOf("\n  pr-gate:", jobStart);
  assert.ok(jobStart >= 0, "pr-verify.yml: no ai-review job found");
  assert.ok(jobEnd > jobStart, "pr-verify.yml: no pr-gate job found after ai-review");
  const job = prVerify.slice(jobStart, jobEnd);

  for (const blocks of [permissionsBlocks(reviewActionYaml), permissionsBlocks(reviewWorkflow), permissionsBlocks(job)]) {
    for (const block of blocks) {
      assert.doesNotMatch(block, /pull-requests:\s*write/);
    }
  }
});

test("llm-review-dialogue.yml holds a write token but never checks out or shells over repository content", () => {
  assert.match(dialogueYaml, /pull-requests:\s*write/);
  assert.doesNotMatch(dialogueYaml, /uses: actions\/checkout/);
  assert.doesNotMatch(dialogueYaml, /\n\s+run: \|/, "no multi-line shell over repository content");
});

// Behavior protected: the deferred-Issue-filing code (issues.create,
// search.issuesAndPullRequests) has a real permission grant behind it, not
// an assumption -- AI Review correctly caught on PR #247 that nothing
// asserted this before those calls were added. `issues: write` was already
// present (needed for posting PR comments via the Issues API), so this pins
// that fact rather than requesting anything new.
test("llm-review-dialogue.yml holds issues: write, which issues.create and search.issuesAndPullRequests both require", () => {
  assert.match(dialogueYaml, /issues:\s*write/);
});

test("llm-review-dialogue.yml triggers on workflow_run, not on any PR event, and adds no PR check row", () => {
  const onBlock = dialogueYaml.slice(dialogueYaml.indexOf("\non:"), dialogueYaml.indexOf("\npermissions:"));
  assert.match(onBlock, /workflow_run:/);
  assert.doesNotMatch(onBlock, /pull_request(_target)?:/);
});

// Issue #272: the reviewer posts under its own App identity when that
// credential is available, and degrades to github.token -- never fails the
// job -- when it is not. Structural, not behavioral: the actual fallback
// logic is covered by the behavioral tests below.
test("llm-review-dialogue.yml mints the reviewer's own App identity from Infisical, with a github.token fallback if it can't", () => {
  assert.match(dialogueYaml, /id-token:\s*write/, "needs id-token: write for the Infisical OIDC exchange");

  const secretsStart = dialogueYaml.indexOf("Infisical/secrets-action");
  assert.ok(secretsStart >= 0, "no Infisical/secrets-action step found");
  const secretsStepStart = dialogueYaml.lastIndexOf("- name:", secretsStart);
  const secretsBlock = dialogueYaml.slice(secretsStepStart, dialogueYaml.indexOf("- name:", secretsStart));
  assert.match(secretsBlock, /continue-on-error:\s*true/, "an unprovisioned reviewer identity must not fail the job");
  assert.match(secretsBlock, /secret-path:\s*"\/review\/"/, "must read the same /review/ path verify-llm-review already reads");

  const tokenStart = dialogueYaml.indexOf("create-github-app-token");
  assert.ok(tokenStart >= 0, "no actions/create-github-app-token step found");
  const tokenStepStart = dialogueYaml.lastIndexOf("- name:", tokenStart);
  const tokenBlock = dialogueYaml.slice(tokenStepStart, dialogueYaml.indexOf("script: |", tokenStart));
  assert.match(tokenBlock, /continue-on-error:\s*true/);
  assert.match(tokenBlock, /app-id:\s*\$\{\{\s*env\.REVIEW_GITHUB_APP_ID\s*\}\}/);
  assert.match(tokenBlock, /private-key:\s*\$\{\{\s*env\.REVIEW_GITHUB_APP_PRIVATE_KEY\s*\}\}/);

  // The posting step's own github-token: input must fall back to github.token
  // rather than leaving the whole step unable to authenticate at all.
  const postingStart = dialogueYaml.indexOf("Dialogue · Post findings");
  const githubTokenLine = dialogueYaml.slice(postingStart, dialogueYaml.indexOf("script: |", postingStart));
  assert.match(githubTokenLine, /github-token:\s*\$\{\{\s*steps\.review-app-token\.outputs\.token\s*\|\|\s*github\.token\s*\}\}/);
});

// The dev agent's own Anthropic credential (model key, distinct from the App
// identity above) is sourced from Infisical's /dev/ path, never a GitHub
// secret -- one credential store per identity, matching the reviewer's own
// model-key pattern (REVIEW_ANTHROPIC_API_KEY lives only in Infisical's
// /review/ path). Defect caught: a future edit that reverts either the
// HAS_ANTHROPIC_* expressions or the /dev/ pull step back to reading a raw
// GitHub secret, silently reintroducing the exact duplicate-credential-copy
// hazard AGENTS.md documents for the platform publishable key.
test("llm-review-dialogue.yml sources the dev agent's Anthropic credential from Infisical, not a GitHub secret", () => {
  const pullStart = dialogueYaml.indexOf("Dialogue · Check whether the dev agent's Anthropic credential is provisioned in Infisical");
  assert.ok(pullStart >= 0, "no dev-agent Infisical presence-check step found");
  const pullStepStart = dialogueYaml.lastIndexOf("- name:", pullStart);
  const pullBlock = dialogueYaml.slice(pullStepStart, dialogueYaml.indexOf("- name:", pullStart));
  assert.match(pullBlock, /continue-on-error:\s*true/, "an unprovisioned dev credential must not fail the posting job");
  assert.match(pullBlock, /secret-path:\s*"\/dev\/"/, "must read the same /dev/ path dev-agent-dispatch.yml's own preflight reads");
  assert.match(pullBlock, /identity-id:\s*\$\{\{\s*vars\.INFISICAL_DEV_IDENTITY_ID\s*\}\}/, "must authenticate as the dev identity, not the reviewer's");

  const postingStart = dialogueYaml.indexOf("Dialogue · Post findings");
  const postingBlock = dialogueYaml.slice(postingStart, dialogueYaml.indexOf("with:", postingStart));
  assert.match(
    postingBlock,
    /HAS_ANTHROPIC_OAUTH:\s*\$\{\{\s*env\.DEV_CLAUDE_CODE_OAUTH_TOKEN\s*!=\s*''\s*\}\}/,
    "HAS_ANTHROPIC_OAUTH must read the Infisical-sourced env var, not secrets.CLAUDE_CODE_OAUTH_TOKEN"
  );
  assert.match(
    postingBlock,
    /HAS_ANTHROPIC_API_KEY:\s*\$\{\{\s*env\.DEV_ANTHROPIC_API_KEY\s*!=\s*''\s*\}\}/,
    "HAS_ANTHROPIC_API_KEY must read the Infisical-sourced env var, not secrets.ANTHROPIC_API_KEY"
  );
  assert.match(
    postingBlock,
    /HAS_DEV_APP_ID:\s*\$\{\{\s*env\.DEV_GITHUB_APP_ID\s*!=\s*''\s*\}\}/,
    "the dialogue preflight must include the dev App ID in its provisioned decision"
  );
  assert.match(
    postingBlock,
    /HAS_DEV_APP_PRIVATE_KEY:\s*\$\{\{\s*env\.DEV_GITHUB_APP_PRIVATE_KEY\s*!=\s*''\s*\}\}/,
    "the dialogue preflight must include the dev App private key in its provisioned decision"
  );
  assert.doesNotMatch(postingBlock, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, "must not fall back to a raw GitHub secret");
  assert.doesNotMatch(postingBlock, /secrets\.ANTHROPIC_API_KEY/, "must not fall back to a raw GitHub secret");

  // Whole-file, not just the sliced blocks above: a stray reference anywhere
  // else in the file (a leftover comment, a second step) would otherwise go
  // undetected -- the block-scoped assertions above prove the WIRING is
  // correct, this proves the OLD path is gone entirely.
  assert.doesNotMatch(dialogueYaml, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, "no reference anywhere in the file");
  assert.doesNotMatch(dialogueYaml, /secrets\.ANTHROPIC_API_KEY/, "no reference anywhere in the file");
});

// Mirrors the test above, for dev-agent-dispatch.yml's own consumption of the
// same Infisical-sourced credential (both the preflight presence-check and
// the actual claude-code-action invocation).
//
// ORACLE CHANGE (Issue #355): this test previously required the Infisical
// pull to run BEFORE the preflight. #355 inverts that deliberately -- the
// dispatch is now validated before any secret is pulled at all -- so the
// ordering claim moved to the containment section below, which asserts the
// new order positively. What survives here unchanged is the claim this test
// was actually written for: WHERE the credential comes from (Infisical's
// /dev/ path, never a raw GitHub secret). The credential-presence env block
// moved with the check itself, to the credential-only preflight step.
test("dev-agent-dispatch.yml pulls its own Anthropic credential from Infisical's /dev/ path, never a GitHub secret", () => {
  const pullStart = dispatchYamlLf.indexOf("Setup · Pull the dev App's credentials from Infisical");
  assert.ok(pullStart >= 0, "no dev App Infisical pull step found");

  const pullStepStart = dispatchYamlLf.lastIndexOf("- name:", pullStart);
  const pullBlock = dispatchYamlLf.slice(pullStepStart, dispatchYamlLf.indexOf("- name:", pullStart));
  assert.match(pullBlock, /secret-path:\s*"\/dev\/"/);
  assert.match(pullBlock, /identity-id:\s*\$\{\{\s*vars\.INFISICAL_DEV_IDENTITY_ID\s*\}\}/);

  const credentialStart = dispatchYamlLf.indexOf(CREDENTIAL_STEP);
  assert.ok(credentialStart >= 0, `no "${CREDENTIAL_STEP}" step found`);
  const credentialBlock = dispatchYamlLf.slice(credentialStart, dispatchYamlLf.indexOf("with:", credentialStart));
  assert.match(credentialBlock, /OAUTH:\s*\$\{\{\s*env\.DEV_CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/);
  assert.match(credentialBlock, /API_KEY:\s*\$\{\{\s*env\.DEV_ANTHROPIC_API_KEY\s*\}\}/);
  assert.doesNotMatch(credentialBlock, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, "must not fall back to a raw GitHub secret");
  assert.doesNotMatch(credentialBlock, /secrets\.ANTHROPIC_API_KEY/, "must not fall back to a raw GitHub secret");

  const resolveStart = dispatchYamlLf.indexOf("Resolve · Hand the findings to the developer agent");
  const resolveBlock = dispatchYamlLf.slice(resolveStart, dispatchYamlLf.indexOf("prompt:", resolveStart));
  assert.match(resolveBlock, /claude_code_oauth_token:\s*\$\{\{\s*env\.DEV_CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/);
  assert.match(resolveBlock, /anthropic_api_key:\s*\$\{\{\s*env\.DEV_ANTHROPIC_API_KEY\s*\}\}/);
  assert.match(
    resolveBlock,
    /claude_args:\s*\|[\s\S]*--model\s+\$\{\{\s*steps\.preflight\.outputs\.model\s*\}\}/,
    "the declared dev.model must be passed to Claude Code, not merely printed in a footer"
  );
  assert.doesNotMatch(
    resolveBlock,
    /DEV_GITHUB_APP_PRIVATE_KEY/,
    "Issue #355: the agent step runs pull-request-authored code and must never see the App private key"
  );

  // Whole-file, not just the sliced blocks above -- see the sibling test's
  // own comment for why this is the failure-sensitivity gap the block-scoped
  // assertions alone leave open.
  assert.doesNotMatch(dispatchYaml, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, "no reference anywhere in the file");
  assert.doesNotMatch(dispatchYaml, /secrets\.ANTHROPIC_API_KEY/, "no reference anywhere in the file");
});

test("llm-review-dialogue.yml refuses fork pull requests before doing anything", () => {
  const jobStart = dialogueYaml.indexOf("jobs:");
  const ifLine = dialogueYaml.slice(jobStart, dialogueYaml.indexOf("permissions:", jobStart));
  // head_repository.fork is GitHub's own documented field for this check.
  assert.match(ifLine, /head_repository\.fork == false/);
});

// ORACLE CHANGE (Issue #355): the final assertion here used to be
// `contents: write` -- this was the one workflow that checked out
// pull-request-authored code while holding an ambient write token. #355
// removes that grant: the workflow still checks out and still writes, but
// the write capability now arrives ONLY as the short-lived dev App
// installation token, minted after validation. The replacement assertion is
// therefore the inverse, and the positive half of the claim (that a real
// write path still exists) is asserted in the containment section below
// against the App token specifically.
test("dev-agent-dispatch.yml triggers on repository_dispatch only, and checks out without any ambient write grant", () => {
  const onBlock = dispatchYamlLf.slice(dispatchYamlLf.indexOf("\non:"), dispatchYamlLf.indexOf("\npermissions:"));
  assert.match(onBlock, /repository_dispatch:/);
  assert.doesNotMatch(onBlock, /pull_request(_target)?:/);
  assert.match(dispatchYamlLf, /uses: actions\/checkout/);
  for (const block of permissionsBlocks(dispatchYamlLf)) {
    assert.doesNotMatch(block, /contents:\s*write/, "Issue #355: no ambient contents: write");
    assert.doesNotMatch(block, /pull-requests:\s*write/, "Issue #355: no ambient pull-requests: write");
  }
});

// Issue #290. Structural, not behavioral -- this proves the instruction is
// PRESENT in the prompt handed to the dispatched agent, not that the agent
// actually complies with it. That is real but weaker evidence than the
// behavioral preflight tests above: nothing here can catch a dispatched
// agent ignoring its own instructions. Kept anyway because the instruction
// existing at all is a real, checkable precondition for compliance, and the
// interpolated provider/model expressions are exactly the kind of typo a
// structural assertion does catch.
test("dev-agent-dispatch.yml's prompt instructs the agent to footer every comment with role/provider/model", () => {
  const promptStart = dispatchYaml.indexOf("prompt: |");
  assert.ok(promptStart >= 0, "no prompt: | block found");
  assert.match(dispatchYaml.slice(promptStart), /footer/i);
  assert.match(dispatchYaml.slice(promptStart), /role `dev`/);
  assert.match(dispatchYaml.slice(promptStart), /\$\{\{\s*steps\.preflight\.outputs\.provider\s*\}\}/);
  assert.match(dispatchYaml.slice(promptStart), /\$\{\{\s*steps\.preflight\.outputs\.model\s*\}\}/);
});

// ---------------------------------------------------------------------------
// Structural: llm-review-recheck.yml (Issue #262's follow-on slice 8) --
// same trust shape as ai-review regardless of trigger path: it executes no
// pull-request-authored code while holding write access, because it never
// holds any write access at all.
// ---------------------------------------------------------------------------

test("llm-review-recheck.yml triggers on repository_dispatch(llm-review-recheck) only, never a PR event, and adds no PR check row", () => {
  const onBlock = recheckYaml.slice(recheckYaml.indexOf("\non:"), recheckYaml.indexOf("\npermissions:"));
  assert.match(onBlock, /repository_dispatch:/);
  assert.match(onBlock, /llm-review-recheck/);
  assert.doesNotMatch(onBlock, /pull_request(_target)?:/);
});

test("llm-review-recheck.yml never holds a write token anywhere -- same trust shape as ai-review, regardless of trigger path", () => {
  for (const block of permissionsBlocks(recheckYaml)) {
    assert.doesNotMatch(block, /pull-requests:\s*write/);
    assert.doesNotMatch(block, /contents:\s*write/);
    assert.doesNotMatch(block, /issues:\s*write/);
  }
  assert.match(recheckYaml, /id-token:\s*write/, "needs id-token: write for the Infisical OIDC exchange, same as ai-review");
});

test("llm-review-recheck.yml checks out only the exact dispatched head, and reuses the same verify-llm-review composite action ai-review does", () => {
  assert.match(recheckYaml, /uses: actions\/checkout/);
  assert.match(recheckYaml, /ref: \$\{\{ github\.event\.client_payload\.headSha \}\}/);
  assert.match(recheckYaml, /uses: \.\/\.github\/actions\/verify-llm-review/);
});

// Extracts the `with:` block immediately following a verify-llm-review
// `uses:` line into a plain key -> raw-expression-text map, using the same
// indentation-bounded scan every other block extractor in this file uses.
function extractVerifyLlmReviewInputs(yamlText) {
  const usesIndex = yamlText.indexOf("uses: ./.github/actions/verify-llm-review");
  assert.ok(usesIndex >= 0, "no verify-llm-review invocation found");
  const withIndex = yamlText.indexOf("with:", usesIndex);
  assert.ok(withIndex >= 0 && withIndex - usesIndex < 100, "no with: block immediately after the verify-llm-review uses: line");
  const lines = yamlText.slice(withIndex + "with:".length).split("\n").slice(1);
  const withIndent = lines[0].match(/^ */)[0].length;
  const inputs = {};
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.match(/^ */)[0].length;
    if (indent < withIndent) break;
    const pair = line.trim().match(/^([a-z_]+):\s*(.*)$/);
    if (pair) inputs[pair[1]] = pair[2].trim();
  }
  return inputs;
}

// THE FIX for AI Review's blocking finding on this PR (round 1): acceptance
// criterion 5 (Issue #268) requires the recheck job to invoke
// verify-llm-review "with the same inputs ai-review passes" -- this was true
// by construction but had no test proving it, so a future edit to either
// job's `with:` block could silently drift the two apart with nothing to
// catch it. pr_number/base_sha/head_sha necessarily use DIFFERENT
// expressions in each trigger's own event context (a repository_dispatch
// payload has no `pull_request` object to read from) -- everything else
// must be byte-for-byte identical, since both invocations exist to
// authenticate and configure the exact same reviewer.
test("llm-review-recheck.yml invokes verify-llm-review with the exact same inputs ai-review passes, for every key not inherently trigger-specific", () => {
  const prVerifyYaml = readFileSync(path.join(root, ".github/workflows/pr-verify.yml"), "utf8");
  const aiReviewJobStart = prVerifyYaml.indexOf("\n  ai-review:");
  const aiReviewJobEnd = prVerifyYaml.indexOf("\n  pr-gate:", aiReviewJobStart);
  assert.ok(aiReviewJobStart >= 0 && aiReviewJobEnd > aiReviewJobStart, "pr-verify.yml: could not isolate the ai-review job block");
  const aiReviewInputs = extractVerifyLlmReviewInputs(prVerifyYaml.slice(aiReviewJobStart, aiReviewJobEnd));
  const recheckInputs = extractVerifyLlmReviewInputs(recheckYaml);

  assert.deepEqual(
    Object.keys(recheckInputs).sort(),
    Object.keys(aiReviewInputs).sort(),
    "the two invocations must pass the exact same set of input keys"
  );

  const contextSpecificKeys = new Set(["pr_number", "base_sha", "head_sha"]);
  for (const key of Object.keys(aiReviewInputs)) {
    if (contextSpecificKeys.has(key)) continue;
    assert.equal(recheckInputs[key], aiReviewInputs[key], `input "${key}" must match ai-review's exactly`);
  }
});

test("neither new workflow adds a second pull_request-triggered workflow to the repo", () => {
  // Reruns the same invariant docs/ops/pr-verify-workflow.test.mjs pins for
  // pr-verify.yml, scoped to the files this Issue and its slice 8 follow-on
  // add -- a second pull_request(_target) trigger anywhere defeats the whole
  // point of using workflow_run/repository_dispatch to avoid another check row.
  for (const text of [dialogueYaml, dispatchYaml, recheckYaml]) {
    const start = text.indexOf("\non:");
    const rest = text.slice(start + 1);
    const endMatch = /\n(?=[A-Za-z_-]+:)/.exec(rest.slice(3));
    const onBlock = endMatch ? rest.slice(0, 3 + endMatch.index) : rest;
    assert.doesNotMatch(onBlock, /^\s{2}pull_request(_target)?:/m);
  }
});

test("every action reference in the new workflows is pinned to a 40-hex SHA with a version comment", () => {
  const pattern = /^\s*uses:\s*(\S+)/gm;
  for (const [name, text] of [
    ["llm-review-dialogue.yml", dialogueYaml],
    ["dev-agent-dispatch.yml", dispatchYaml],
    ["llm-review-recheck.yml", recheckYaml],
  ]) {
    for (const match of text.matchAll(pattern)) {
      const ref = match[1];
      if (ref.startsWith("./")) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${name}: unpinned action reference: ${ref}`);
      const line = text.slice(match.index, text.indexOf("\n", match.index));
      assert.match(line, /# v[0-9]/, `${name}: missing version comment: ${line.trim()}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Behavioral: the dialogue script, executed against a mocked GitHub API.
// ---------------------------------------------------------------------------

function makeArtifact(fs, path_, dir, files) {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;
    fs.writeFileSync(path_.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

function makeGithub({
  pr,
  existingComment = null,
  dispatchThrows = false,
  searchResults = [],
  createIssueThrows = false,
  // Issue #326: simulates the pulls review-comment API rejecting a suggestion
  // anchor (e.g. a 422 for a line outside the diff), which must degrade to
  // the managed comment, never fail delivery.
  reviewCommentThrows = false,
  // Fixture for the default-branch agent-roles.yaml the dialogue script now
  // reads to decide whether the assigned dev provider is the one this
  // repository's dispatcher actually implements (anthropic, today).
  devProvider = "anthropic",
  // Issue #289: the same fixture also backs the review.provider/model
  // footer. Defaults match this repo's actual live agent-roles.yaml
  // assignment (openai/gpt-5-mini is the real pair; "y" here is an
  // arbitrary distinct-from-devProvider placeholder pre-dating #289, kept
  // as the default so no pre-existing test's behavior changes).
  reviewProvider = "openai",
  reviewModel = "y",
}) {
  const calls = { updateComment: [], createComment: [], createDispatchEvent: [], createIssue: [], search: [], createReviewComment: [] };
  let nextIssueNumber = 300;
  let nextReviewCommentId = 900;
  const api = {
    rest: {
      pulls: {
        get: async () => ({ data: pr }),
        createReviewComment: async (args) => {
          calls.createReviewComment.push(args);
          if (reviewCommentThrows) throw new Error("simulated line-anchor failure");
          const id = nextReviewCommentId;
          nextReviewCommentId += 1;
          return { data: { id } };
        },
      },
      issues: {
        listComments: async () => (existingComment ? [existingComment] : []),
        createComment: async (args) => {
          calls.createComment.push(args);
        },
        updateComment: async (args) => {
          calls.updateComment.push(args);
        },
        create: async (args) => {
          calls.createIssue.push(args);
          if (createIssueThrows) throw new Error("simulated Issue-creation failure");
          const number = nextIssueNumber;
          nextIssueNumber += 1;
          return { data: { number } };
        },
      },
      repos: {
        createDispatchEvent: async (args) => {
          calls.createDispatchEvent.push(args);
          if (dispatchThrows) throw new Error("simulated dispatch failure");
        },
        getContent: async () => ({
          data: {
            encoding: "base64",
            content: Buffer.from(
              `dev:\n  provider: ${devProvider}\n  model: x\n\nreview:\n  provider: ${reviewProvider}\n  model: ${reviewModel}\n`,
              "utf8"
            ).toString("base64"),
          },
        }),
      },
      search: {
        issuesAndPullRequests: async (args) => {
          calls.search.push(args);
          return { data: { items: searchResults } };
        },
      },
    },
    paginate: async (fn) => fn(),
  };
  return { api, calls };
}

function makeCore() {
  const warnings = [];
  const infos = [];
  return {
    warning: (message) => warnings.push(message),
    info: (message) => infos.push(message),
    summary: { addHeading: () => {}, addRaw: () => {}, write: async () => {} },
    warnings,
    infos,
  };
}

async function runDialogue(
  fs,
  os,
  path_,
  env,
  { pr, existingComment, dispatchThrows, searchResults, createIssueThrows, reviewCommentThrows, devProvider, reviewProvider, reviewModel } = {}
) {
  const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "llm-review-dialogue-test-"));
  makeArtifact(fs, path_, dir, env.__files);
  delete env.__files;
  const { api, calls } = makeGithub({ pr, existingComment, dispatchThrows, searchResults, createIssueThrows, reviewCommentThrows, devProvider, reviewProvider, reviewModel });
  const core = makeCore();
  // Most dialogue tests exercise behavior after successful provisioning, so
  // App presence defaults true. A test for incomplete identity provisioning
  // must override the relevant flag explicitly; the regression test below
  // does so for the private-key-missing case.
  const proc = {
    env: {
      HAS_DEV_APP_ID: "true",
      HAS_DEV_APP_PRIVATE_KEY: "true",
      ...env,
      ARTIFACT_DIR: dir,
    },
  };
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  await loadDialogueScript()(require, context, core, api, proc);
  return { calls, core };
}

const HEAD = "a".repeat(40);
const BASE_PR = { number: 230, head: { sha: HEAD }, state: "open" };
const BLOCKING_VERDICT = {
  verdict: "block",
  findings: [{ severity: "blocking", category: "test", claim: "c", evidence: "e", requestedChange: "r", citation: "AGENTS.md > x" }],
  discarded: [],
  summary: "s",
};

test("dialogue: a fresh blocking verdict opens round 1, posts one new comment, and wakes the agent", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createComment.length, 1);
  assert.equal(calls.updateComment.length, 0);
  const body = calls.createComment[0].body;
  assert.ok(body.startsWith("<!-- agent-engineering-standard:llm-review:v1 -->"), "marker must be the first bytes of the comment");
  assert.match(body, /"round":1/);
  assert.doesNotMatch(body, /needs your decision/);
  assert.equal(calls.createDispatchEvent.length, 1);
  assert.equal(calls.createDispatchEvent[0].client_payload.round, 1);
});

// Issue #289. Behavior protected: the managed comment ends with a footer
// stating role/provider/model, sourced from agent-roles.yaml's review.*
// fields specifically -- not dev.* -- so an implementation that misread the
// wrong half of the file is caught. Distinct provider/model values from
// devProvider (fixed at "anthropic" by BLOCKING_VERDICT's own default)
// make that mix-up impossible to pass accidentally.
test("dialogue: the managed comment ends with a role/provider/model footer sourced from agent-roles.yaml's review fields", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, reviewProvider: "gemini", reviewModel: "gemini-3-pro" });

  const body = calls.createComment[0].body;
  assert.match(body, /_AI Review — role `review` · provider `gemini` · model `gemini-3-pro`_/);
});

// Extracts the COMPLETE run-reported footer line. Splitting the body first is
// the point: an assertion run against the whole comment could not tell a value
// that stayed on one line from one that spilled onto the next.
function runReportedLine(body) {
  const lines = body.split("\n").filter((line) => line.startsWith("_Run-reported configuration"));
  assert.equal(lines.length, 1, `exactly one run-reported line expected, got ${lines.length}`);
  return lines[0];
}

const RUN_PROVENANCE = {
  reviewerProvider: "openai",
  reviewerModel: "gpt-5-mini",
  builderProvider: "anthropic",
  builderModel: "claude-opus-5",
};

// Issue #354 follow-up. Behavior protected: the managed comment states the
// run-reported configuration -- both halves -- so the record of who reviewed
// whose work is durable rather than inferable only from a job log that expires.
// Defect caught: a change that validates the builder identity at the credential
// boundary and then never carries it anywhere a human can read it, which is
// what made the whole guard unverifiable after the fact.
//
// The values come from review-meta.json, written by the action's own steps
// from the resolved config -- never from review-verdict.json, which is model
// output shaped by pull-request content. Reported, not attested: see the
// forged-provider test below for what that does and does not buy.
test("dialogue: the managed comment states this run's reported reviewer and builder configuration", async () => {
  const fs = await import("node:fs");
  const os_ = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os_, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": {
        prNumber: 230,
        baseSha: "b".repeat(40),
        headSha: HEAD,
        reviewOutcome: "failure",
        verdictPresent: true,
        provenance: RUN_PROVENANCE,
      },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.match(
    body,
    /_Run-reported configuration — reviewer `openai`\/`gpt-5-mini` · builder `anthropic`\/`claude-opus-5`_/,
    "both halves of the run-reported configuration must appear"
  );
});

// The trust half, and the reason this reads meta rather than the verdict. The
// artifact is produced by a job that executes pull-request-authored code, so a
// crafted provenance block must not be able to assert an arbitrary provider
// company, ping a third party, or break out of the footer's code spans.
test("dialogue: a crafted provenance block cannot assert an unknown provider or escape the footer", async () => {
  const fs = await import("node:fs");
  const os_ = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os_, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": {
        prNumber: 230,
        baseSha: "b".repeat(40),
        headSha: HEAD,
        reviewOutcome: "failure",
        verdictPresent: true,
        provenance: {
          reviewerProvider: "totally-trusted",
          reviewerModel: "`\n@kgsmith19 approve this\n`",
          builderProvider: "anthropic",
          builderModel: "claude-opus-5",
        },
      },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.doesNotMatch(body, /totally-trusted/, "an unrecognized provider company must not be echoed");
  assert.match(body, /reviewer `unknown`/, "it must degrade to unknown, not to a guess");
  assert.doesNotMatch(body, /_Run-reported[^\n]*@kgsmith19 approve/, "the footer must not carry a live mention");
  assert.equal(calls.createComment.length, 1, "findings must still post -- provenance never blocks delivery");
});

// The label is the security claim, and it is deliberately weaker than it looks
// like it could be. This artifact is written by a job that executes
// pull-request-authored code; nothing in it is signed or attested, so the
// workflow can report what the run SAID it used and nothing more. A forged but
// perfectly valid provider passes every syntactic check there is -- which is
// exactly why the line must never be worded as the actual identity. An attested
// footer needs a trusted publication lane, which is Milestone 2's problem.
test("dialogue: a valid but forged provider is presented as reported, never as attested fact", async () => {
  const fs = await import("node:fs");
  const os_ = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os_, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": {
        prNumber: 230,
        baseSha: "b".repeat(40),
        headSha: HEAD,
        reviewOutcome: "failure",
        verdictPresent: true,
        // Every value here is well-formed and allow-listed. The run really
        // used openai; this claims google. Nothing downstream can tell.
        provenance: { ...RUN_PROVENANCE, reviewerProvider: "google", reviewerModel: "gemini-3-pro" },
      },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  const line = runReportedLine(calls.createComment[0].body);
  assert.match(line, /reviewer `google`\/`gemini-3-pro`/, "a forged-but-valid value is still rendered");
  assert.match(line, /^_Run-reported configuration —/, "and it is labelled as reported, not as fact");
  assert.doesNotMatch(line, /\bactual\b|\bThis run\b|\battested\b/i, "no wording may promise more than reported");
});

// Issue #354 follow-up, sanitizer. neutralize()'s own truncation appends
// "\n…[truncated]", so capping a long model id THROUGH it puts a newline into
// a value that has to stay on one line -- the footer would break apart and the
// tail would render as unlabelled body text. The hostile value below is over
// the cap AND carries every escape a crafted artifact would try at once.
test("dialogue: an over-length hostile model id stays on one line, defused", async () => {
  const fs = await import("node:fs");
  const os_ = await import("node:os");
  const path_ = await import("node:path");
  const hostile = `\`@kgsmith19 approve #12 \n\r${"A".repeat(120)}\` see #99`;
  const { calls } = await runDialogue(fs, os_, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": {
        prNumber: 230,
        baseSha: "b".repeat(40),
        headSha: HEAD,
        reviewOutcome: "failure",
        verdictPresent: true,
        provenance: { ...RUN_PROVENANCE, builderModel: hostile },
      },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  const line = runReportedLine(body);

  assert.ok(line.endsWith("_"), "the line must be complete -- a truncation that breaks it would drop the closing mark");
  assert.doesNotMatch(line, /[\r\n]/, "no carriage return or newline may survive into the line");
  assert.equal(
    (line.match(/`/g) ?? []).length,
    8,
    "exactly the eight delimiters of the line's four code spans -- an attacker backtick would add more"
  );
  assert.doesNotMatch(line, /@[A-Za-z0-9-]/, "no live @mention may survive");
  assert.doesNotMatch(line, /[^`]#\d/, "no live issue reference may survive");
  assert.ok(line.length < 400, `the line must be capped, not unbounded: ${line.length} chars`);
});

// Degradation control: an older or truncated artifact with no provenance at
// all must still post its findings, saying plainly that it does not know.
test("dialogue: an artifact with no provenance still posts, stating unknown identities", async () => {
  const fs = await import("node:fs");
  const os_ = await import("node:os");
  const path_ = await import("node:path");
  const { calls, core } = await runDialogue(fs, os_, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createComment.length, 1, "an unknown identity must never stop findings from posting");
  assert.match(
    calls.createComment[0].body,
    /_Run-reported configuration — reviewer `unknown`\/`unknown` · builder `unknown`\/`unknown`_/
  );
  // `unknown` in a footer is honest but easy to skim past, so the run log says
  // it too. The producer side warns as well; this is the consumer half, and it
  // covers an artifact staged by an older run that never wrote provenance.
  assert.ok(
    core.warnings.some((warning) => /run-reported configuration/i.test(warning)),
    `the missing configuration must be announced in the log: ${JSON.stringify(core.warnings)}`
  );
});

// Behavior protected: a PASSING verdict's comment also carries the footer --
// the footer is not conditional on `blocking`, unlike the round/identity
// escalation admonitions.
test("dialogue: a passing verdict's comment also carries the role/provider/model footer", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "d".repeat(40);
  const priorState = { round: 1, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "5",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "success", verdictPresent: true },
      "review-verdict.json": { verdict: "pass", findings: [], discarded: [], summary: "all good" },
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment, reviewProvider: "openai", reviewModel: "gpt-5-mini" });

  const body = calls.updateComment[0].body;
  assert.match(body, /_AI Review — role `review` · provider `openai` · model `gpt-5-mini`_/);
});

test("dialogue: REVIEW_APP_TOKEN_MINTED=true posts findings with no fallback-identity warning", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls, core } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    REVIEW_APP_TOKEN_MINTED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createComment.length, 1, "findings must still post");
  assert.ok(
    !core.warnings.some((w) => w.includes("github-actions[bot]")),
    "a successfully minted identity must not warn about a fallback that didn't happen"
  );
});

test("dialogue: an unminted reviewer identity (unset, or the App credential failed) still posts findings, with a visible fallback warning", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  // REVIEW_APP_TOKEN_MINTED deliberately omitted -- this is the real shape a
  // run takes when the Infisical pull or the token mint step fails
  // (continue-on-error: true means the job proceeds, but the env var this
  // step reads is simply never set to "true").
  const { calls, core } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createComment.length, 1, "an identity fallback must never stop findings from posting");
  assert.ok(
    core.warnings.some((w) => w.includes("github-actions[bot]")),
    "the fallback must be visible in the run log, not silent"
  );
});

// Issue #288: a separate, independent streak from round/escalated above --
// round only increments on `blocking && !sameHead`, so a cleanly-passing PR
// would never trip a shared counter, which is exactly the case most likely
// to hide a permanently-broken reviewer App credential forever. This streak
// instead counts every consecutive run (blocking or not) that had to fall
// back to github-actions[bot].
test("dialogue: identity-fallback streak escalates at the default threshold (1) with a distinct admonition, separate from round escalation", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  // REVIEW_APP_TOKEN_MINTED omitted -- first-ever fallback, no prior comment.
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "10",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.match(body, /"identityFallbackStreak":1/);
  assert.match(body, /"identityEscalated":true/);
  assert.match(body, /@kgsmith19 — the reviewer's own posting identity has not minted/);
  // The round-escalation admonition must NOT also fire here -- round is only
  // 1 of an ESCALATE_AFTER: 10 threshold, proving the two counters are
  // genuinely independent rather than one leaking into the other.
  assert.doesNotMatch(body, /this needs your decision/);
});

test("dialogue: a second consecutive identity fallback updates the streak in place, without a duplicate comment", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const priorState = {
    round: 1,
    headSha: HEAD,
    escalated: false,
    identityFallbackStreak: 1,
    identityEscalated: true,
    verdict: "block",
  };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  // Same head as the prior run -- REVIEW_APP_TOKEN_MINTED still omitted.
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "2",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "10",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, existingComment });

  assert.equal(calls.updateComment.length, 1);
  assert.equal(calls.createComment.length, 0, "the same managed comment must be updated, never a second one");
  assert.match(calls.updateComment[0].body, /"identityFallbackStreak":2/);
  assert.match(calls.updateComment[0].body, /"identityEscalated":true/);
});

test("dialogue: a successful mint resets the identity-fallback streak and clears the escalation, removing the admonition", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = {
    round: 1,
    headSha: HEAD,
    escalated: false,
    identityFallbackStreak: 3,
    identityEscalated: true,
    verdict: "block",
  };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "3",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    ESCALATE_AFTER: "10",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    REVIEW_APP_TOKEN_MINTED: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"identityFallbackStreak":0/);
  assert.match(body, /"identityEscalated":false/);
  assert.doesNotMatch(body, /posting identity has not minted/);
});

// Mutation-sensitive: proves the two admonition blocks are built
// independently, so one being rendered can never accidentally suppress or
// overwrite the other -- the failure mode a shared `if` (or a single `return`
// early) would produce.
test("dialogue: round-escalation and identity-escalation admonitions can both render in the same comment without clobbering", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = {
    round: 2,
    headSha: HEAD,
    escalated: false,
    identityFallbackStreak: 0,
    identityEscalated: false,
    verdict: "block",
  };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  // REVIEW_APP_TOKEN_MINTED omitted -- this run both crosses ESCALATE_AFTER
  // (round 2 -> 3, threshold 3) AND fails to mint the reviewer identity
  // (default identity threshold 1), so both escalations must fire together.
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "4",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":3/);
  assert.match(body, /"escalated":true/);
  assert.match(body, /"identityFallbackStreak":1/);
  assert.match(body, /"identityEscalated":true/);
  assert.match(body, /this needs your decision/);
  assert.match(body, /posting identity has not minted/);
});

test("dialogue: a re-run on the same head updates the one comment in place without incrementing the round", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const priorState = { round: 1, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "2",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, existingComment });

  assert.equal(calls.updateComment.length, 1);
  assert.equal(calls.createComment.length, 0);
  assert.match(calls.updateComment[0].body, /"round":1/);
});

test("dialogue: an unresolved finding surviving to a new head increments the round and escalates once the threshold is reached", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = { round: 2, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "3",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":3/);
  assert.match(body, /"escalated":true/);
  assert.match(body, /@kgsmith19 — this needs your decision/);
});

// Behavior protected (Issue #284, owner directive): with ESCALATE_AFTER
// unset, the workflow's own DEFAULT_ESCALATE_AFTER applies -- which must now
// be 10, not 9 (itself raised from 3 by #281). This is the true
// defect-sensitive half: it fails against the pre-#284 default, where round
// 9 (>= 9) would already have escalated. Paired with the positive control
// below (round 10 does escalate) so this proves the exact boundary, not just
// "somewhere higher than 9".
test("dialogue: with ESCALATE_AFTER unset, round 9 does NOT yet escalate -- the default is 10, not 9", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = { round: 8, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "9",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":9/);
  assert.match(body, /"escalated":false/);
  assert.doesNotMatch(body, /@kgsmith19 — this needs your decision/);
});

// POSITIVE CONTROL for the default itself: round 10 with ESCALATE_AFTER
// unset does escalate, pinning the exact new default value rather than just
// "greater than 9".
test("dialogue: with ESCALATE_AFTER unset, round 10 escalates -- confirming the new default value", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "c".repeat(40);
  const priorState = { round: 9, headSha: HEAD, escalated: false, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "10",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":10/);
  assert.match(body, /"escalated":true/);
  assert.match(body, /@kgsmith19 — this needs your decision/);
});

test("dialogue: a passing verdict resets the round and clears any prior escalation", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const newHead = "d".repeat(40);
  const priorState = { round: 3, headSha: HEAD, escalated: true, verdict: "block" };
  const existingComment = {
    id: 555,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\nold`,
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "4",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: newHead,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: newHead, reviewOutcome: "success", verdictPresent: true },
      "review-verdict.json": { verdict: "pass", findings: [], discarded: [], summary: "clean" },
    },
  }, { pr: { number: 230, head: { sha: newHead }, state: "open" }, existingComment });

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":0/);
  assert.match(body, /"escalated":false/);
  assert.equal(calls.createDispatchEvent.length, 0);
});

test("dialogue SECURITY: refuses to post when the artifact's claimed PR head does not match the run it came from", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const mismatchedPr = { number: 230, head: { sha: "e".repeat(40) }, state: "open" };
  const { calls, core } = await runDialogue(fs, os, path_, {
    RUN_ID: "5",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: mismatchedPr });

  assert.equal(calls.createComment.length, 0);
  assert.equal(calls.updateComment.length, 0);
  assert.equal(calls.createDispatchEvent.length, 0);
  assert.ok(core.warnings.some((warning) => warning.includes("Refusing to post")));
});

test("dialogue: no verdict artifact (unprovisioned preflight or infrastructure failure) posts nothing", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "6",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: false },
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createComment.length, 0);
  assert.equal(calls.updateComment.length, 0);
});

test("dialogue: an unprovisioned agent escalates to the owner immediately, without waiting for the round threshold", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "7",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "false",
    HAS_ANTHROPIC_API_KEY: "false",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR });

  assert.equal(calls.createDispatchEvent.length, 0);
  const body = calls.createComment[0].body;
  assert.match(body, /@kgsmith19 — this needs your decision/);
  assert.match(body, /is not provisioned/);
});

test("dialogue: a model credential without both dev App credentials never dispatches a fixer", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const oneSidedCredentials = [
    { HAS_DEV_APP_ID: "true", HAS_DEV_APP_PRIVATE_KEY: "false" },
    { HAS_DEV_APP_ID: "false", HAS_DEV_APP_PRIVATE_KEY: "true" },
  ];

  for (const credentials of oneSidedCredentials) {
    const { calls } = await runDialogue(fs, os, path_, {
      RUN_ID: `7-app-missing-${credentials.HAS_DEV_APP_ID}`,
      RUN_URL: "http://x",
      RUN_HEAD_SHA: HEAD,
      ESCALATE_AFTER: "3",
      HAS_ANTHROPIC_OAUTH: "true",
      HAS_ANTHROPIC_API_KEY: "false",
      ...credentials,
      __files: {
        "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
        "review-verdict.json": BLOCKING_VERDICT,
      },
    }, { pr: BASE_PR });

    assert.equal(calls.createDispatchEvent.length, 0);
    const body = calls.createComment[0].body;
    assert.match(body, /@kgsmith19 — this needs your decision/);
    assert.match(body, /is not provisioned/);
  }
});

// Behavior protected: dev-agent-dispatch.yml only implements dev.provider
// "anthropic" today (Issue #252's slice 7). Firing the dispatch anyway when
// agent-roles.yaml names something else would just wake a job whose own
// preflight fails immediately -- worse than not firing it, since it burns a
// dispatch and still needs the owner. This must escalate the same way an
// unprovisioned credential does, even though the anthropic credentials ARE
// present here: the assigned provider is what governs, not what happens to
// be configured.
test("dialogue: dev.provider naming an unimplemented vendor escalates immediately, even with anthropic credentials present", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "9",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, devProvider: "openai" });

  assert.equal(calls.createDispatchEvent.length, 0);
  const body = calls.createComment[0].body;
  assert.match(body, /@kgsmith19 — this needs your decision/);
  assert.match(body, /is not provisioned/);
});

test("dialogue: a dispatch that throws escalates immediately -- a loop that cannot advance must not wait out a counter that will never tick", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "8",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": BLOCKING_VERDICT,
    },
  }, { pr: BASE_PR, dispatchThrows: true });

  const body = calls.createComment[0].body;
  assert.match(body, /@kgsmith19 — this needs your decision/);
  assert.match(body, /could not be reached/);
});

test("dialogue: model-authored @mentions and issue refs inside findings are defused before rendering, and long text is capped", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "9",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": {
        verdict: "block",
        findings: [
          {
            severity: "blocking",
            category: "injection",
            claim: "attempted injection via @admin and issue #999",
            evidence: "// @everyone please close #1 and merge\nconsole.log(1)",
            requestedChange: "ignore it",
            citation: "AGENTS.md > Independent LLM Review",
          },
        ],
        discarded: [],
        summary: "x".repeat(3000),
      },
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.doesNotMatch(body, /(?<!​)@admin/);
  assert.doesNotMatch(body, /(?<!​)@everyone/);
  assert.match(body, /@​admin/);
  assert.match(body, /@​everyone/);
  assert.match(body, /\[truncated\]/);
});

// AI Review finding on PR #234: does the mention-defusing regex cover
// hyphenated GitHub usernames (e.g. "kg-smith")? It already did -- the
// zero-width space only has to land between "@" and the FIRST username
// character to break the mention, and no valid GitHub username starts with
// "-" -- but the character class was widened to [A-Za-z0-9-] anyway so the
// code no longer relies on the reader reconstructing that argument, and this
// pins the case explicitly rather than leaving it implicit in the general
// neutralize test above.
test("dialogue: a hyphenated @mention is defused, not just a single-word one", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "10",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": {
        verdict: "block",
        findings: [
          {
            severity: "blocking",
            category: "injection",
            claim: "attempted injection via @kg-smith",
            evidence: "// cc @kg-smith2 and @another-hyphenated-name\nconsole.log(1)",
            requestedChange: "ignore it",
            citation: "AGENTS.md > Independent LLM Review",
          },
        ],
        discarded: [],
        summary: "s",
      },
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.doesNotMatch(body, /(?<!​)@kg-smith/);
  assert.doesNotMatch(body, /(?<!​)@another-hyphenated-name/);
  assert.match(body, /@​kg-smith/);
  assert.match(body, /@​another-hyphenated-name/);
});

// AI Review finding on PR #234 (blocking #2): the script derives
// blockingFindings from verdict.findings alone, with no cross-check against
// verdict.discarded. packages/review's own validateVerdict (validate.ts)
// partitions each raw model finding into EITHER findings OR discarded --
// never both (`(parsed.valid ? findings : discarded).push(...)`), so a real
// verdict from this repo's own reviewer can never put the same finding in
// both arrays. But the dialogue script treats the staged artifact as data
// crossing a job boundary, not as a call into validateVerdict directly (see
// the SHA-mismatch security test above) -- so this test constructs a verdict
// a *malformed* producer could emit (a "blocking"-severity entry sitting in
// discarded) and confirms the script still only ever counts verdict.findings
// toward blocking/round/dispatch, exactly as Issue #231 claim 4 and
// AGENTS.md's "discarded findings ... cannot block" require, regardless of
// what shape a future or malformed producer hands it.
test("dialogue: an entry in verdict.discarded never counts toward blocking, even if mislabeled 'blocking' severity", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "11",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": {
        verdict: "block",
        findings: [
          { severity: "blocking", category: "real", claim: "the one real finding", evidence: "e", requestedChange: "r", citation: "AGENTS.md > x" },
        ],
        discarded: [
          { severity: "blocking", category: "malformed", claim: "should never block", evidence: "", requestedChange: "", citation: "" },
        ],
        summary: "s",
      },
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.match(body, /### Blocking findings \(1\)/);
  assert.match(body, /the one real finding/);
  // The discarded entry is still rendered -- for transparency, under its own
  // "Discarded" section -- so what matters is WHERE it lands, not whether it
  // appears at all: it must come after the Discarded heading, never inside
  // the Blocking findings section above it.
  const blockingHeadingEnd = body.indexOf("### Blocking findings (1)") + "### Blocking findings (1)".length;
  const discardedHeadingIndex = body.indexOf("Discarded (1)");
  const discardedTextIndex = body.indexOf("should never block");
  assert.ok(discardedHeadingIndex > blockingHeadingEnd, "Discarded heading must come after Blocking findings");
  assert.ok(discardedTextIndex > discardedHeadingIndex, "the discarded entry's text must render after the Discarded heading, not inside Blocking findings");
  assert.equal(calls.createDispatchEvent.length, 1);
  assert.equal(calls.createDispatchEvent[0].client_payload.round, 1, "round/dispatch must derive from findings alone, not be inflated by discarded");
});

// ---------------------------------------------------------------------------
// Structural: Issue #355 -- dispatch credential containment.
//
// This workflow is the single place in the repository where three things
// meet: pull-request-authored code is checked out and EXECUTED, a model
// credential is in scope, and something able to write to the repository is
// in scope. Before #355 the containment for that was entirely upstream --
// llm-review-dialogue.yml only dispatches for same-repository pull requests
// -- and upstream-only containment fails the moment anything else learns to
// fire an `llm-review-finding` repository_dispatch. `repository_dispatch`
// carries an attacker-shaped `client_payload` by construction: it is a plain
// JSON body posted to an API, not a GitHub-populated event context.
//
// So the invariant these tests pin is ordering, not merely presence: the
// dispatch is proved to name an open, same-repository, non-fork pull request
// at the exact head it claims BEFORE any secret exists in the job at all,
// and the App private key is destroyed BEFORE the checkout that brings
// pull-request-authored content onto the runner.
// ---------------------------------------------------------------------------

// Every `- name:` step in the job, in file order, with its own block text.
function dispatchSteps() {
  const stepsStart = dispatchYamlLf.indexOf("\n    steps:\n");
  assert.ok(stepsStart >= 0, "dev-agent-dispatch.yml: no steps: block found");
  const body = dispatchYamlLf.slice(stepsStart);
  const steps = [];
  const pattern = /\n {6}- name: (.+)/g;
  for (const match of body.matchAll(pattern)) {
    steps.push({ name: match[1].trim(), index: match.index });
  }
  assert.ok(steps.length > 0, "dev-agent-dispatch.yml: no named steps found");
  return steps.map((step, i) => ({
    ...step,
    block: body.slice(step.index, i + 1 < steps.length ? steps[i + 1].index : undefined),
  }));
}

function dispatchStep(name) {
  const step = dispatchSteps().find((candidate) => candidate.name.includes(name));
  assert.ok(step, `dev-agent-dispatch.yml: step matching "${name}" not found`);
  return step;
}

// A `permissions:` block parsed into its actual scope/level pairs, so the
// assertion can be an exact set rather than a grep for the two levels
// someone happened to think of.
function parsePermissions(block) {
  const parsed = {};
  for (const line of block.split("\n")) {
    const match = /^\s*([a-z-]+):\s*(\S+)\s*$/.exec(line);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

// THE CORE ORDERING INVARIANT. Behavior protected: nothing that pulls,
// mints, or exposes a credential -- and nothing that brings pull-request
// content onto the runner -- can run before the dispatch has been validated.
// Defect caught: the pre-#355 shape exactly, where the Infisical pull was
// the FIRST step in the job and therefore ran for a malformed, forked, or
// closed-PR dispatch just as readily as a real one.
test("dispatch containment: validation runs first, then credentials, mint, clear, checkout, agent -- in that order", () => {
  const names = dispatchSteps().map((step) => step.name);
  const at = (needle) => {
    const index = names.findIndex((name) => name.includes(needle));
    assert.ok(index >= 0, `dev-agent-dispatch.yml: no step matching "${needle}"`);
    return index;
  };

  assert.equal(names[0], VALIDATION_STEP, "the validation step must be the FIRST executable step in the job");

  const validate = at(VALIDATION_STEP);
  const infisical = at("Pull the dev App's credentials from Infisical");
  const credentials = at(CREDENTIAL_STEP);
  const mint = at("Mint the dev App's installation token");
  const clear = at("Clear the dev App's private key");
  const checkout = at("Checkout the validated pull request head");
  const agent = at("Hand the findings to the developer agent");

  assert.ok(validate < infisical, "no secret may be pulled before the dispatch is validated");
  assert.ok(infisical < credentials, "the credential check needs the pulled secrets in scope");
  assert.ok(credentials < mint, "mint only after the App credential is confirmed present");
  assert.ok(mint < clear, "the private key can only be cleared once it has been exchanged for a token");
  assert.ok(clear < checkout, "the private key must be gone BEFORE pull-request content reaches the runner");
  assert.ok(checkout < agent, "the agent runs against the checked-out validated head");
});

// Behavior protected: the ambient GITHUB_TOKEN this job holds while running
// pull-request-authored code cannot write anything. Asserted as an exact set
// rather than a pair of doesNotMatch greps, so a newly-added `issues: write`
// -- a level neither this test nor its author thought of -- fails too.
test("dispatch containment: ambient job permissions are exactly contents/pull-requests read plus OIDC", () => {
  const blocks = permissionsBlocks(dispatchYamlLf);
  assert.equal(blocks.length, 2, "expected exactly a workflow-level and a job-level permissions block");

  assert.deepEqual(parsePermissions(blocks[0]), { contents: "read" }, "workflow-level default stays read-only");
  assert.deepEqual(
    parsePermissions(blocks[1]),
    { contents: "read", "pull-requests": "read", "id-token": "write" },
    "the job's ambient token must be read-only; id-token: write is the OIDC exchange, not repository write"
  );
});

// Behavior protected: the validation step decides eligibility with NO secret
// in scope. Defect caught: reintroducing the credential-presence env block
// into the first step, which would put the App private key into the
// environment of the one step whose whole job is to run before secrets exist.
test("dispatch containment: the validation step is reached with no secret-valued env", () => {
  const validation = dispatchStep(VALIDATION_STEP);
  const envBlock = validation.block.slice(0, validation.block.indexOf("with:"));
  assert.doesNotMatch(envBlock, /DEV_GITHUB_APP_PRIVATE_KEY/);
  assert.doesNotMatch(envBlock, /DEV_GITHUB_APP_ID/);
  assert.doesNotMatch(envBlock, /DEV_ANTHROPIC_API_KEY/);
  assert.doesNotMatch(envBlock, /DEV_CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(envBlock, /PR_NUMBER:\s*\$\{\{\s*github\.event\.client_payload\.prNumber\s*\}\}/);
  assert.match(envBlock, /DISPATCH_HEAD_SHA:\s*\$\{\{\s*github\.event\.client_payload\.headSha\s*\}\}/);
});

// Behavior protected: EVERY step after validation is gated on the validation
// verdict, with the exact same expression. Defect caught: a step added later
// without a guard, or with a subtly weaker one (`!= 'false'`, `!cancelled()`)
// that lets an ineligible dispatch through the one door nobody re-checked.
test("dispatch containment: every step after validation is guarded on eligible == 'true'", () => {
  const [first, ...rest] = dispatchSteps();
  assert.equal(first.name, VALIDATION_STEP);
  assert.ok(rest.length >= 6, "expected the credential, mint, clear, checkout, agent and recheck steps");

  for (const step of rest) {
    const guard = /\n {8}if: steps\.preflight\.outputs\.eligible == 'true'\n/;
    assert.match(step.block, guard, `step "${step.name}" is not guarded on the validation verdict`);
  }
});

// Behavior protected: the App private key is removed from the job
// environment, via GITHUB_ENV so the removal outlives the step, before any
// pull-request-authored content is on the runner -- and is never referenced
// again afterwards. Defect caught: a later step re-reading
// env.DEV_GITHUB_APP_PRIVATE_KEY (for a second mint, say), which would mean
// the key was still live while the agent executed PR code all along.
test("dispatch containment: the App private key is cleared through GITHUB_ENV before checkout, and never referenced after", () => {
  const clear = dispatchStep("Clear the dev App's private key");
  assert.match(clear.block, /GITHUB_ENV/, "the clear must persist past this step, which means writing GITHUB_ENV");
  assert.match(clear.block, /DEV_GITHUB_APP_ID=/, "must clear the App ID");
  assert.match(clear.block, /DEV_GITHUB_APP_PRIVATE_KEY=/, "must clear the App private key");

  const after = dispatchYamlLf.slice(dispatchYamlLf.indexOf(clear.block) + clear.block.length);
  assert.doesNotMatch(after, /DEV_GITHUB_APP_PRIVATE_KEY/, "no reference to the private key after it is cleared");
  assert.doesNotMatch(after, /DEV_GITHUB_APP_ID/, "no reference to the App ID after it is cleared");
});

// Behavior protected: the checkout takes the exact SHA the validation step
// verified, not a branch name that can be force-pushed between validation
// and checkout; brings no credential with it that survives into the working
// tree; and authenticates with the short-lived App token rather than the
// ambient one. Defect caught: `ref:` reverting to the branch ref, which
// reopens a real TOCTOU window -- validation proves head X is safe, then
// checkout fetches whatever the branch points at now.
test("dispatch containment: checkout takes the validated SHA, with no persisted credential", () => {
  const checkout = dispatchStep("Checkout the validated pull request head");
  assert.match(checkout.block, /uses: actions\/checkout/);
  assert.match(
    checkout.block,
    /ref:\s*\$\{\{\s*steps\.preflight\.outputs\.head_sha\s*\}\}/,
    "must check out the validated SHA, never a mutable branch ref"
  );
  assert.match(checkout.block, /fetch-depth:\s*0/);
  assert.match(checkout.block, /persist-credentials:\s*false/);
  assert.match(checkout.block, /token:\s*\$\{\{\s*steps\.dev-app-token\.outputs\.token\s*\}\}/);
});

// Behavior protected: the agent's only GitHub capability is the short-lived
// App installation token, and it will act on events from exactly one trusted
// bot -- the reviewer App that raises the findings. Defect caught: a
// wildcard or a `github-actions` entry, either of which would accept any
// workflow-authored event in the repository as a legitimate initiator.
//
// The Controller App assertion is a DOCUMENTATION oracle, and weaker than
// the rest of this test by design: it proves the deferral is recorded, not
// that the login is right. `hyperbolic-core-controller[bot]` does not
// resolve against the users API today, so allowlisting it now would be
// squatting on a name nobody has provisioned -- exactly the way a future
// unrelated App could inherit trust it was never granted.
test("dispatch containment: the agent gets the App token only, and trusts only the provisioned reviewer bot", () => {
  const agent = dispatchStep("Hand the findings to the developer agent");
  const inputs = agent.block.slice(0, agent.block.indexOf("prompt:"));

  assert.match(inputs, /github_token:\s*\$\{\{\s*steps\.dev-app-token\.outputs\.token\s*\}\}/);
  assert.doesNotMatch(inputs, /github\.token/, "no ambient-token fallback for the agent's GitHub operations");
  assert.match(inputs, /allowed_bots:\s*hyperbolic-core-reviewer\[bot\]\s*$/m, "exactly the reviewer App, nothing else");
  assert.doesNotMatch(inputs, /allowed_bots:.*\*/, "never a wildcard initiator allowlist");
  assert.doesNotMatch(inputs, /allowed_bots:.*github-actions/, "github-actions[bot] is every workflow in the repo, not an identity");

  assert.match(
    dispatchYamlLf,
    /Milestone 2[\s\S]{0,400}?[Cc]ontroller App/,
    "the deferred Controller App entry must stay recorded until the login is provisioned and verified"
  );
});

// Behavior protected: the recheck dispatch -- the one repository mutation
// this job performs directly, rather than through the agent -- is issued
// with the App token, not the ambient read-only one. Defect caught: dropping
// the github-token input, which makes the step silently fall back to the
// ambient token; post-#355 that token can no longer create a dispatch event,
// so the review loop would stall on every comment-only reply.
test("dispatch containment: the recheck dispatch is issued with the dev App token", () => {
  const recheck = dispatchStep("Fire a recheck if the agent replied without pushing a commit");
  const inputs = recheck.block.slice(0, recheck.block.indexOf("script: |"));
  assert.match(inputs, /github-token:\s*\$\{\{\s*steps\.dev-app-token\.outputs\.token\s*\}\}/);
  assert.doesNotMatch(inputs, /github\.token/, "no ambient-token fallback for a repository mutation");
});

// ---------------------------------------------------------------------------
// Behavioral: dev-agent-dispatch.yml's validation step (Issue #355) --
// schema, dev role from the DEFAULT branch, and the live pull request, in
// that order, with the cheapest checks first so a malformed payload never
// costs an API call.
// ---------------------------------------------------------------------------

const THIS_REPO = { owner: "kgsmith19", repo: "hyperbolic-core" };
const THIS_REPO_FULL_NAME = "kgsmith19/hyperbolic-core";
const VALID_RUN_URL = `https://github.com/${THIS_REPO_FULL_NAME}/actions/runs/17284419901`;

function agentRolesFixture(devProvider, devModel = "x") {
  return Buffer.from(
    `dev:\n  provider: ${devProvider}\n  model: ${devModel}\n\nreview:\n  provider: openai\n  model: y\n`,
    "utf8"
  ).toString("base64");
}

function livePr(overrides = {}) {
  return {
    number: 230,
    state: "open",
    head: { sha: HEAD, ref: "issue/355-x", repo: { fork: false, full_name: THIS_REPO_FULL_NAME } },
    base: { repo: { full_name: THIS_REPO_FULL_NAME } },
    ...overrides,
  };
}

function validationSource() {
  const marker = dispatchYamlLf.indexOf(VALIDATION_STEP);
  assert.ok(marker >= 0, `dev-agent-dispatch.yml: step "${VALIDATION_STEP}" not found`);
  return extractScript(dispatchYamlLf, marker);
}

async function runValidation({
  prNumber = "230",
  headSha = HEAD,
  round = "1",
  runUrl = VALID_RUN_URL,
  devProvider = "anthropic",
  devModel = "x",
  agentRolesRaw = null,
  getContentThrows = false,
  pr = livePr(),
  pullsGetThrows = false,
  source = null,
  // Caller-supplied so the recorded outputs survive a script that throws --
  // the fail-closed test below needs to see what was written BEFORE the throw.
  outputs = {},
} = {}) {
  const calls = { getContent: 0, pullsGet: 0 };
  let failure = null;
  const core = {
    setOutput: (key, value) => (outputs[key] = value),
    setFailed: (message) => (failure = message),
    info: () => {},
    warning: () => {},
  };
  const github = {
    rest: {
      repos: {
        getContent: async () => {
          calls.getContent += 1;
          if (getContentThrows) throw new Error("simulated getContent failure");
          return {
            data: {
              encoding: "base64",
              content: agentRolesRaw !== null ? agentRolesRaw : agentRolesFixture(devProvider, devModel),
            },
          };
        },
      },
      pulls: {
        get: async () => {
          calls.pullsGet += 1;
          if (pullsGetThrows) throw new Error("simulated pulls.get failure");
          return { data: pr };
        },
      },
    },
  };
  const proc = {
    env: { PR_NUMBER: prNumber, DISPATCH_HEAD_SHA: headSha, ROUND: round, RUN_URL: runUrl },
  };
  const script = new AsyncFunction("require", "context", "core", "github", "process", source ?? validationSource());
  await script(require, { repo: THIS_REPO }, core, github, proc);
  return { outputs, failure, calls };
}

// POSITIVE CONTROL. Behavior protected: the real, everyday case -- an open,
// same-repository pull request at exactly the dispatched head, with a
// supported dev role -- is eligible, and every value the rest of the job
// consumes comes out of THIS step rather than being re-read from the
// attacker-shaped client_payload downstream.
test("validation: an open same-repository PR at the exact dispatched head is eligible, and republishes every input", async () => {
  const { outputs, failure } = await runValidation();

  assert.equal(failure, null);
  assert.equal(outputs.eligible, "true");
  assert.equal(outputs.pr_number, "230");
  assert.equal(outputs.head_sha, HEAD);
  assert.equal(outputs.branch, "issue/355-x");
  assert.equal(outputs.provider, "anthropic");
  assert.equal(outputs.model, "x");
  assert.equal(outputs.round, "1");
  assert.equal(outputs.run_url, VALID_RUN_URL);
});

// Behavior protected: eligibility is DENIED BY DEFAULT -- written false
// before any check runs, so an unexpected failure mid-validation leaves an
// explicit false behind rather than an unset output that every downstream
// `if:` would then compare against an empty string. Defect caught: moving
// the initial setOutput below the checks.
//
// The API failure itself must still propagate: a swallowed pulls.get error
// would turn "GitHub was briefly unreachable" into a silent stand-down that
// looks exactly like "this dispatch was stale", which AGENTS.md's own
// no-silent-failure rule forbids. So both halves are asserted -- it throws,
// AND it left false behind on the way out.
test("validation: eligibility is written false before any check, so a mid-validation failure still fails closed", async () => {
  const outputs = {};
  await assert.rejects(
    () => runValidation({ pullsGetThrows: true, outputs }),
    /simulated pulls\.get failure/,
    "an API failure during validation must surface, never be swallowed into a quiet stand-down"
  );
  assert.equal(outputs.eligible, "false", "eligibility must already be explicitly false when the failure hits");
});

// Behavior protected: the schema checks are genuinely FIRST -- a malformed
// payload costs zero API calls. This is not only efficiency: the role lookup
// and the PR lookup are the two places this job touches the network on
// behalf of an unvalidated caller.
for (const [label, payload] of [
  ["a non-numeric PR number", { prNumber: "not-a-number" }],
  ["a zero PR number", { prNumber: "0" }],
  ["a negative PR number", { prNumber: "-3" }],
  ["a fractional PR number", { prNumber: "2.5" }],
  ["an empty PR number", { prNumber: "" }],
  ["a short head SHA", { headSha: "abc1234" }],
  ["an over-long head SHA", { headSha: "a".repeat(41) }],
  ["a non-hex head SHA", { headSha: "z".repeat(40) }],
  ["an empty head SHA", { headSha: "" }],
  ["a zero round", { round: "0" }],
  ["a non-numeric round", { round: "one" }],
  ["an empty round", { round: "" }],
  ["a run URL on another host", { runUrl: "https://evil.example.com/kgsmith19/hyperbolic-core/actions/runs/1" }],
  ["a run URL for another repository", { runUrl: "https://github.com/someone/else/actions/runs/1" }],
  ["a run URL that is not an Actions run", { runUrl: "https://github.com/kgsmith19/hyperbolic-core/issues/355" }],
  ["a non-URL run reference", { runUrl: "javascript:alert(1)" }],
]) {
  test(`validation: ${label} is rejected before any role or pull-request lookup`, async () => {
    const { outputs, failure, calls } = await runValidation(payload);

    assert.notEqual(outputs.eligible, "true");
    assert.ok(failure, "a malformed dispatch must fail loudly, not stand down quietly");
    assert.equal(calls.getContent, 0, "no role lookup for a malformed payload");
    assert.equal(calls.pullsGet, 0, "no pull-request lookup for a malformed payload");
  });
}

// Behavior protected: an unsupported dev provider stops before the pull
// request is even looked up. Defect caught: reordering the PR lookup ahead
// of the role check, which would spend an API call on behalf of a dispatch
// this job has already decided it cannot serve.
for (const provider of ["openai", "google"]) {
  test(`validation: dev.provider=${provider} fails closed without a pull-request lookup`, async () => {
    const { outputs, failure, calls } = await runValidation({ devProvider: provider });

    assert.notEqual(outputs.eligible, "true");
    assert.equal(outputs.provider, provider, "the resolved provider is still reported, so the failure names it");
    assert.match(failure, new RegExp(`dev\\.provider="${provider}"`));
    assert.match(failure, /only implements "anthropic"/);
    assert.equal(calls.getContent, 1);
    assert.equal(calls.pullsGet, 0, "an unsupported provider must not reach the PR lookup");
  });
}

// Behavior protected: the role policy must be READABLE and COMPLETE before
// it is trusted. A blank provider or a blank model is not "close enough" --
// the model id is interpolated into the agent's own command line, and an
// empty one would silently run whatever the action defaults to.
//
// Every fixture below carries a `review:` block, because agent-roles.yaml
// always does and the difference is not cosmetic: a parser that walks the
// file rather than the `dev:` mapping reads the REVIEWER's values when the
// dev block's own are missing. An isolated `dev:`-only fixture returns null
// and makes that parser look fail-closed when it is not.
for (const [label, fixture] of [
  ["no recognizable dev block", "not: a\nrecognizable: shape\n"],
  ["a blank dev.provider", 'dev:\n  provider: ""\n  model: x\n\nreview:\n  provider: openai\n  model: y\n'],
  ["a blank dev.model", "dev:\n  provider: anthropic\n  model:\n\nreview:\n  provider: openai\n  model: gpt-5-mini\n"],
  // The two that a file-wide parse gets actively WRONG rather than merely
  // empty. Without dev.provider the reviewer's provider is read as the dev
  // one -- and when the reviewer is the anthropic role, that resolves to the
  // one supported adapter and runs, on a role policy that never named a dev
  // provider at all. Without dev.model the model regex skips past the blank
  // line and returns the literal "review:" as the model id, which is
  // non-empty, passes a blank check, and reaches Claude Code's --model flag.
  ["no dev.provider at all, above an anthropic review block", "dev:\n  model: claude-opus-5\n\nreview:\n  provider: anthropic\n  model: z\n"],
  ["no dev.model at all, above a populated review block", "dev:\n  provider: anthropic\n\nreview:\n  provider: openai\n  model: gpt-5-mini\n"],
]) {
  test(`validation: agent-roles.yaml with ${label} fails closed without a pull-request lookup`, async () => {
    const { outputs, failure, calls } = await runValidation({
      agentRolesRaw: Buffer.from(fixture, "utf8").toString("base64"),
    });

    assert.notEqual(outputs.eligible, "true");
    assert.ok(failure, "an unusable role policy must fail closed");
    assert.equal(calls.pullsGet, 0);
  });
}

test("validation: agent-roles.yaml unreadable from the default branch fails closed with the real error", async () => {
  const { outputs, failure, calls } = await runValidation({ getContentThrows: true });
  assert.notEqual(outputs.eligible, "true");
  assert.match(failure, /simulated getContent failure/);
  assert.equal(calls.pullsGet, 0);
});

// THE INDEPENDENT ORACLE for the role parser: the repository's own
// committed agent-roles.yaml, not a fixture written to match the regex.
// Every fixture above is a simplification, and a simplification is exactly
// where a parser bug hides -- the real file carries a trailing `# ...`
// comment on every value and a long comment header above the mappings, both
// of which a naive parse gets wrong in a different direction from the blank
// cases. This test fails if a fix for those over-corrects and stops reading
// the file the workflow actually depends on.
test("validation: the role parser resolves this repository's real agent-roles.yaml", async () => {
  const real = readFileSync(path.join(root, "agent-roles.yaml"), "utf8");
  const { outputs, failure } = await runValidation({
    agentRolesRaw: Buffer.from(real, "utf8").toString("base64"),
  });

  assert.equal(failure, null, "the committed role policy must parse cleanly");
  assert.equal(outputs.provider, "anthropic", "dev.provider, with its trailing inline comment stripped");
  assert.equal(outputs.model, "claude-opus-5", "dev.model, with its trailing inline comment stripped");
  assert.equal(outputs.eligible, "true");
});

// Behavior protected: the role policy is read from the DEFAULT branch, never
// the dispatched pull request's own branch. Defect caught: adding a `ref:`
// that points at the PR head, which would let a pull request grant itself a
// different dev identity by editing its own agent-roles.yaml.
test("validation: the role policy is read without a ref, which is the default branch", () => {
  const source = validationSource();
  const call = /getContent\(\{([^}]*)\}\)/.exec(source);
  assert.ok(call, "the validation step must read agent-roles.yaml through the Contents API");
  assert.doesNotMatch(call[1], /\bref\b/, "reading a ref would let the PR branch supply its own role policy");
});

// Behavior protected: the ways a pull request can be the wrong pull request.
// The fork and cross-repository cases are the security ones -- this job
// executes what it checks out, so a head outside this repository is
// arbitrary third-party code running alongside a minted App token in the
// job. The stale and closed cases preserve the pre-#355 stand-down behavior.
for (const [label, override] of [
  [
    "a head that has moved on",
    { head: { sha: "b".repeat(40), ref: "issue/355-x", repo: { fork: false, full_name: THIS_REPO_FULL_NAME } } },
  ],
  ["a closed pull request", { state: "closed" }],
  ["a merged, now-closed pull request", { state: "closed", merged: true }],
  ["a fork head", { head: { sha: HEAD, ref: "issue/355-x", repo: { fork: true, full_name: "attacker/hyperbolic-core" } } }],
  [
    "a same-name fork claiming not to be one",
    { head: { sha: HEAD, ref: "issue/355-x", repo: { fork: false, full_name: "attacker/hyperbolic-core" } } },
  ],
  ["a deleted head repository", { head: { sha: HEAD, ref: "issue/355-x", repo: null } }],
  ["a cross-repository base", { base: { repo: { full_name: "kgsmith19/somewhere-else" } } }],
]) {
  test(`validation: ${label} is not eligible`, async () => {
    const { outputs } = await runValidation({ pr: livePr(override) });
    assert.notEqual(outputs.eligible, "true", `${label} must never reach a credential`);
  });
}

// MUTATION SENSITIVITY DEMONSTRATION (AGENTS.md > Intent and behavioral
// claims: R2/R3 work touching a gate needs a demonstrated negative control).
//
// The fork/cross-repository tests above assert that a hostile head is
// rejected -- but a test asserting "not eligible" passes just as happily
// against a validation step that rejects EVERYTHING, or one that never sets
// the output at all. So this applies a plausible targeted mutation to the
// real extracted script -- collapsing the provenance guard's condition to
// `false`, exactly what "simplifying a redundant check" would produce -- and
// proves the suite's verdict flips. If this test ever fails, the fork tests
// above have stopped being able to reject anything.
test("validation NEGATIVE CONTROL: collapsing the provenance guard makes a fork dispatch eligible", async () => {
  const source = validationSource();
  const guard = /if \(([^\n]*headRepo[^\n]*)\) \{/.exec(source);
  assert.ok(guard, "the validation step must guard on the head repository's provenance");

  const mutated = source.replace(guard[1], "false");
  assert.notEqual(mutated, source, "the mutation must actually change the script");

  const fork = livePr({
    head: { sha: HEAD, ref: "issue/355-x", repo: { fork: true, full_name: "attacker/hyperbolic-core" } },
  });

  const real = await runValidation({ pr: fork });
  assert.notEqual(real.outputs.eligible, "true", "the real guard rejects the fork");

  const mutant = await runValidation({ pr: fork, source: mutated });
  assert.equal(
    mutant.outputs.eligible,
    "true",
    "with the guard collapsed the fork becomes eligible -- which is what proves the guard, not the fixture, is doing the rejecting"
  );
});

// ---------------------------------------------------------------------------
// Behavioral: dev-agent-dispatch.yml's credential preflight (Issue #355) --
// the second half of the split preflight. Runs only for an already-eligible
// dispatch, after Infisical has put the secrets in scope, and checks only
// that they are present. These claims are unchanged from the pre-#355
// preflight; only the step they live in moved.
// ---------------------------------------------------------------------------

async function runCredentialPreflight({
  oauth = "",
  apiKey = "",
  appId = "app-id-value",
  appPrivateKey = "app-private-key-value",
} = {}) {
  let failure = null;
  const core = { setFailed: (message) => (failure = message), info: () => {}, setOutput: () => {} };
  const proc = { env: { OAUTH: oauth, API_KEY: apiKey, APP_ID: appId, APP_PRIVATE_KEY: appPrivateKey } };
  await loadCredentialPreflightScript()(require, { repo: THIS_REPO }, core, {}, proc);
  return { failure };
}

// POSITIVE CONTROL.
test("credential preflight: both App secrets and a model credential present resolves without failing", async () => {
  const { failure } = await runCredentialPreflight({ oauth: "token-value" });
  assert.equal(failure, null);
});

test("credential preflight: no model credential fails closed and names both accepted secrets", async () => {
  const { failure } = await runCredentialPreflight({ oauth: "", apiKey: "" });
  assert.match(failure, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(failure, /ANTHROPIC_API_KEY/);
});

test("credential preflight: a model credential but no dev App credential fails closed and names both App secrets", async () => {
  const { failure } = await runCredentialPreflight({ oauth: "token-value", appId: "", appPrivateKey: "" });
  assert.match(failure, /DEV_GITHUB_APP_ID/);
  assert.match(failure, /DEV_GITHUB_APP_PRIVATE_KEY/);
});

test("credential preflight: one dev App secret present but not the other still fails closed", async () => {
  for (const credentials of [
    { appId: "app-id-value", appPrivateKey: "" },
    { appId: "", appPrivateKey: "app-private-key-value" },
  ]) {
    const { failure } = await runCredentialPreflight({ oauth: "token-value", ...credentials });
    assert.match(failure, /DEV_GITHUB_APP_ID/);
    assert.match(failure, /DEV_GITHUB_APP_PRIVATE_KEY/);
  }
});

// ---------------------------------------------------------------------------
// Behavioral: dev-agent-dispatch.yml's last step -- firing llm-review-recheck
// when the agent replied without pushing a commit (Issue #262's follow-on
// slice 8).
// ---------------------------------------------------------------------------

// THE CORE NEW BEHAVIOR. Behavior protected: an unchanged head (the agent
// only commented -- a rebuttal or an out-of-scope proposal) fires the
// recheck dispatch with the PR's own current head. Defect caught: never
// firing at all, which would leave a comment-only reply invisible to AI
// Review forever, since pull_request:synchronize only fires on an actual push.
test("recheck-fire: dispatches llm-review-recheck when the PR head is unchanged", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const core = { info: () => {}, warning: () => {} };
  const calls = [];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: HEAD } } }) },
      repos: { createDispatchEvent: async (args) => calls.push(args) },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckFireScript()(context, core, github, proc);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].event_type, "llm-review-recheck");
  assert.deepEqual(calls[0].client_payload, { prNumber: 230, headSha: HEAD });
});

// Behavior protected: a head that moved during the dispatcher's own run (the
// agent pushed a commit) skips the recheck entirely -- pull_request:synchronize
// already retriggered AI Review on the real pr-verify.yml path, so firing a
// second, redundant recheck against a now-stale head would be pure waste.
test("recheck-fire: does not dispatch when the PR head has moved -- the agent's own push already retriggers AI Review", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const infos = [];
  const core = { info: (message) => infos.push(message), warning: () => {} };
  const calls = [];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: "moved".padEnd(40, "0") } } }) },
      repos: { createDispatchEvent: async (args) => calls.push(args) },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckFireScript()(context, core, github, proc);

  assert.equal(calls.length, 0);
  assert.ok(infos.some((message) => message.includes("Not firing a recheck")));
});

// Behavior protected: a dispatch failure warns rather than throwing --
// this step runs after the agent's own reply already posted, so a transient
// dispatch-API failure must not fail the whole job and hide that the reply
// itself succeeded.
test("recheck-fire: a dispatch failure warns instead of throwing", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const warnings = [];
  const core = { info: () => {}, warning: (message) => warnings.push(message) };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { head: { sha: HEAD } } }) },
      repos: {
        createDispatchEvent: async () => {
          throw new Error("simulated dispatch failure");
        },
      },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckFireScript()(context, core, github, proc);

  assert.match(warnings[0], /simulated dispatch failure/);
});

// ---------------------------------------------------------------------------
// Behavioral: llm-review-recheck.yml's own staleness guard -- the mirror
// image of dev-agent-dispatch.yml's PR-check step, run a second time inside
// the recheck job itself since the PR could have moved again in the gap
// between the firing step above and this job actually starting.
// ---------------------------------------------------------------------------

test("recheck context: a PR that moved past the dispatched head stands down", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  const core = { setOutput: (key, value) => (outputs[key] = value), info: () => {} };
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { number: 230, head: { sha: "moved".padEnd(40, "0") }, state: "open", base: { sha: "b".repeat(40) } } }),
      },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckContextScript()(context, core, github, proc);

  assert.equal(outputs.stale, "true");
  assert.equal(outputs.base_sha, undefined);
});

test("recheck context: a closed PR at the right head still stands down -- there is nothing left to recheck", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  const core = { setOutput: (key, value) => (outputs[key] = value), info: () => {} };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { number: 230, head: { sha: HEAD }, state: "closed", base: { sha: "b".repeat(40) } } }) },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckContextScript()(context, core, github, proc);

  assert.equal(outputs.stale, "true");
});

test("recheck context: a still-current, still-open PR proceeds and exposes the base sha for verify-llm-review", async () => {
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const outputs = {};
  const core = { setOutput: (key, value) => (outputs[key] = value), info: () => {} };
  const baseSha = "b".repeat(40);
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { number: 230, head: { sha: HEAD }, state: "open", base: { sha: baseSha } } }) },
    },
  };
  const proc = { env: { PR_NUMBER: "230", DISPATCH_HEAD_SHA: HEAD } };

  await loadRecheckContextScript()(context, core, github, proc);

  assert.equal(outputs.stale, "false");
  assert.equal(outputs.base_sha, baseSha);
});

// ---------------------------------------------------------------------------
// verify-llm-review/action.yml's "Context · Write the linked Issue body and
// the pull request body to files" step -- Issue #251. Before this, the PR's
// own body was only ever a fallback that got unconditionally overwritten the
// moment an Issue number resolved (effectively always, since
// verify-pr-description requires a Closes/Fixes/Resolves reference on every
// PR), so the reviewer never actually saw a PR's own Verification section,
// oracle-change disclosure, or scope reasoning in normal operation. These
// tests pin the fix: both files exist, independently, every time.
// ---------------------------------------------------------------------------

async function runIssueAndPrBodyScript({ prNumber = 240, headRef = "some-branch", prBody = "", issue = null, issueThrows = false } = {}) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "llm-review-issue-pr-body-test-"));
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { head: { ref: headRef }, body: prBody } }) },
      issues: {
        get: async () => {
          if (issueThrows) throw new Error("simulated API failure");
          return { data: issue ?? { title: "(missing fixture issue)", body: "" } };
        },
      },
    },
  };
  const core = { info: () => {}, warning: () => {} };
  const proc = { env: { PR_NUMBER: String(prNumber), RUNNER_TEMP: dir } };

  await loadIssueAndPrBodyScript()(require, context, core, github, proc);

  return {
    issueBody: fs.readFileSync(path_.join(dir, "issue-body.md"), "utf8"),
    prBody: fs.readFileSync(path_.join(dir, "pr-body.md"), "utf8"),
  };
}

// THE EXACT BUG (Issue #251). Behavior protected: when an Issue resolves
// (the normal case), the reviewer still gets the PR's own body -- not just
// the Issue's. Defect caught: the old code path, where resolving an Issue
// unconditionally overwrote the one `body` variable that the PR body was
// ever assigned to, making it structurally invisible in exactly this case.
test("Issue-and-PR-body step: the PR body is captured alongside a resolved Issue body, not overwritten by it", async () => {
  const { issueBody, prBody } = await runIssueAndPrBodyScript({
    headRef: "issue/42-configurable-rate",
    prBody: "## Verification\nRan the full suite locally, all green.",
    issue: { title: "Make the discount rate configurable", body: "Acceptance criterion 1: ..." },
  });

  assert.match(issueBody, /Issue #42: Make the discount rate configurable/);
  assert.match(issueBody, /Acceptance criterion 1/);
  assert.match(prBody, /Ran the full suite locally, all green/);
  assert.ok(!issueBody.includes("Ran the full suite locally"), "the PR body must not leak into the Issue body file");
});

// Behavior protected: the Issue number resolves from the branch name first,
// via this standard's own issue/<n>-<slug> convention.
test("Issue-and-PR-body step: the Issue number resolves from the branch name", async () => {
  const { issueBody } = await runIssueAndPrBodyScript({
    headRef: "issue/251-pr-body-invisible",
    issue: { title: "AI Review never sees the PR body", body: "..." },
  });
  assert.match(issueBody, /Issue #251:/);
});

// Behavior protected: when no Issue can be identified, the Issue-body file
// says so plainly, and the PR body is still written -- it is no longer
// pressed into service as a fallback substitute for the missing Issue body.
test("Issue-and-PR-body step: no linked Issue still writes the PR's own body, unmixed with a fallback notice", async () => {
  const { issueBody, prBody } = await runIssueAndPrBodyScript({
    headRef: "some-unrelated-branch-name",
    prBody: "Just a quick fix.",
  });

  assert.match(issueBody, /no linked Issue could be identified/);
  assert.equal(prBody, "Just a quick fix.");
  assert.ok(!issueBody.includes("Just a quick fix"), "the PR body must not be folded into the Issue-body placeholder");
});

// Behavior protected: a PR with no description at all writes an explicit
// placeholder rather than an empty file, so "no description" and "review
// error" cannot be confused downstream.
test("Issue-and-PR-body step: a pull request with no body writes an explicit placeholder", async () => {
  const { prBody } = await runIssueAndPrBodyScript({ prBody: null });
  assert.match(prBody, /this pull request has no description/);
});

async function runConversationScript(issueComments, reviewComments = []) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const dir = fs.mkdtempSync(path_.join(os.tmpdir(), "llm-review-conversation-test-"));
  const context = { repo: { owner: "kgsmith19", repo: "hyperbolic-core" } };
  const github = {
    rest: {
      issues: { listComments: async () => ({ data: issueComments }) },
      pulls: { listReviewComments: async () => ({ data: reviewComments }) },
    },
    paginate: async (fn) => (await fn()).data,
  };
  const core = { info: () => {} };
  const proc = { env: { PR_NUMBER: "240", RUNNER_TEMP: dir } };

  await loadConversationScript()(require, context, core, github, proc);
  return fs.readFileSync(path_.join(dir, "pr-conversation.md"), "utf8");
}

// Behavior protected: comments render chronologically (listComments' own
// order, never re-sorted), each carrying its author and timestamp, so the
// reviewer can tell a fix description from an earlier rebuttal apart.
// Defect caught: dropping the author/timestamp, which would make "who said
// this, and was it before or after the last verdict?" unanswerable from the
// rendered text alone.
test("conversation step: renders comments chronologically with author and timestamp", async () => {
  const body = await runConversationScript([
    { user: { login: "github-actions[bot]" }, created_at: "2026-08-18T00:00:00Z", body: "round 1 verdict: block" },
    { user: { login: "kgsmith19" }, created_at: "2026-08-18T01:00:00Z", body: "fixed, please re-check" },
  ]);

  const firstIndex = body.indexOf("round 1 verdict: block");
  const secondIndex = body.indexOf("fixed, please re-check");
  assert.ok(firstIndex >= 0 && secondIndex >= 0, "both comment bodies must appear");
  assert.ok(firstIndex < secondIndex, "comments must render in chronological order");
  assert.match(body, /github-actions\[bot\] \(2026-08-18T00:00:00Z\)/);
  assert.match(body, /kgsmith19 \(2026-08-18T01:00:00Z\)/);
});

// Behavior protected: inline review-thread comments (pulls.listReviewComments
// -- a different API surface from top-level issue comments) are fetched too,
// and merged into ONE chronological stream rather than appended after all
// issue comments regardless of when they were actually posted. Defect
// caught (this is the exact AI Review finding on PR #244 that this test
// exists to pin down): fetching only issues.listComments, which silently
// drops every inline "why is this line...?" reply from the reviewer's view.
test("conversation step: inline review comments are fetched and merged chronologically with issue comments", async () => {
  const body = await runConversationScript(
    [
      { user: { login: "github-actions[bot]" }, created_at: "2026-08-18T00:00:00Z", body: "round 1 verdict: block" },
      { user: { login: "kgsmith19" }, created_at: "2026-08-18T02:00:00Z", body: "fixed, please re-check" },
    ],
    [
      {
        user: { login: "kgsmith19" },
        created_at: "2026-08-18T01:00:00Z",
        body: "why does this line truncate at 100 chars?",
        path: "packages/review/src/context.ts",
        line: 42,
      },
    ]
  );

  const verdictIndex = body.indexOf("round 1 verdict: block");
  const inlineIndex = body.indexOf("why does this line truncate");
  const fixedIndex = body.indexOf("fixed, please re-check");
  assert.ok(verdictIndex >= 0 && inlineIndex >= 0 && fixedIndex >= 0, "all three comments must appear");
  assert.ok(
    verdictIndex < inlineIndex && inlineIndex < fixedIndex,
    "the inline review comment must sort between the two issue comments by created_at, not be appended after both"
  );
  assert.match(body, /kgsmith19 \(2026-08-18T01:00:00Z\) on packages\/review\/src\/context\.ts:42:/);
});

// Behavior protected: a pull request with no comments yet (the common case
// on a first-round review) writes an empty file rather than throwing --
// gatherContext's own default ("") and prompt.ts's first-round placeholder
// depend on this being a clean empty string, not an error or "undefined".
test("conversation step: no comments yet writes an empty conversation, not an error", async () => {
  const body = await runConversationScript([]);
  assert.equal(body, "");
});

// ---------------------------------------------------------------------------
// Deferred (outOfScope) findings: rendered separately, never blocking, and
// filed as a non-blocking Issue -- idempotently across re-runs.
// ---------------------------------------------------------------------------

const DEFERRED_FINDING = {
  severity: "blocking",
  category: "lean",
  file: "src/pricing.ts",
  line: 10,
  claim: "The discount cap belongs in a shared constants module.",
  evidence: "const CAP = 0.5;",
  requestedChange: "Move CAP to packages/shared/constants.ts in a follow-up.",
  citation: "AGENTS.md > Lean engineering",
  outOfScope: true,
};

// packages/review/src/validate.ts already excludes outOfScope from the
// block/pass computation, so a verdict containing ONLY a deferred finding
// arrives here as "pass" -- this fixture matches that real contract rather
// than asserting something validate.ts would never actually produce.
const DEFERRED_ONLY_VERDICT = {
  verdict: "pass",
  findings: [DEFERRED_FINDING],
  discarded: [],
  summary: "One finding, agreed out of scope in the conversation.",
};

function deferredEnv(overrides = {}) {
  return {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
      "review-verdict.json": DEFERRED_ONLY_VERDICT,
    },
    ...overrides,
  };
}

// Behavior protected: a fresh outOfScope finding is rendered in its own
// "Deferred findings" section (never the blocking section), and files
// exactly one new Issue, linked back from the rendered finding.
// Defect caught: leaving outOfScope findings in blockingFindings (the exact
// bug that would keep this PR red despite the deferral), or never actually
// calling issues.create.
test("dialogue: a fresh outOfScope finding renders as deferred, not blocking, and files one Issue", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, deferredEnv(), { pr: BASE_PR });

  assert.equal(calls.createIssue.length, 1, "exactly one Issue must be filed");
  assert.match(calls.createIssue[0].title, /discount cap belongs in a shared constants module/);
  assert.deepEqual(calls.createIssue[0].labels, ["source:ai-review"]);
  assert.match(calls.createIssue[0].body, /Does not block #230/);
  assert.match(calls.createIssue[0].body, /^<!-- llm-review-deferred: [0-9a-f]{16} -->/);

  const body = calls.createComment[0].body;
  assert.match(body, /### Deferred findings \(1\) — agreed out of scope, does not block/);
  assert.doesNotMatch(body, /### Blocking findings/);
  assert.match(body, /\*\*Tracked in\.\*\* #300/);
  assert.match(body, /"verdict":"pass"/);
});

// Issue #289. Behavior protected: the deferred-finding Issue body ALSO ends
// with the role/provider/model footer, independently of the managed PR
// comment's own footer -- both call sites build this string, so a fix to
// one alone (or a copy-paste that reads dev.* here by mistake) is caught.
test("dialogue: the deferred-finding Issue body also carries the role/provider/model footer", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, deferredEnv(), {
    pr: BASE_PR,
    reviewProvider: "anthropic",
    reviewModel: "claude-opus-5",
  });

  assert.match(
    calls.createIssue[0].body,
    /_AI Review — role `review` · provider `anthropic` · model `claude-opus-5`_$/,
    "footer must be the last thing in the deferred Issue's body"
  );
});

// NEGATIVE CONTROL / idempotency. Behavior protected: re-running the SAME
// finding (same fingerprint) against a comment that already recorded it does
// NOT file a second Issue -- the whole point of tracking deferredIssues in
// the managed comment's own state. Defect caught: filing a new Issue on
// every re-run (a label/edit-triggered retrigger, a re-run of the same
// workflow run) instead of reusing the recorded number.
test("dialogue: re-running the same deferred finding does not file a duplicate Issue", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const fingerprint = require("node:crypto")
    .createHash("sha256")
    .update(`${DEFERRED_FINDING.category}|${DEFERRED_FINDING.file}|${DEFERRED_FINDING.line}`)
    .digest("hex")
    .slice(0, 16);
  const priorState = { round: 0, headSha: HEAD, escalated: false, deferredIssues: { [fingerprint]: 555 } };
  const existingComment = {
    id: 1,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\n\nprior body`,
  };

  const { calls } = await runDialogue(fs, os, path_, deferredEnv(), { pr: BASE_PR, existingComment });

  assert.equal(calls.createIssue.length, 0, "no new Issue may be filed for an already-recorded fingerprint");
  assert.equal(calls.updateComment.length, 1);
  assert.match(calls.updateComment[0].body, /\*\*Tracked in\.\*\* #555/);
});

// Behavior protected: state loss (a hand-edited or corrupted managed
// comment) degrades to "found by search," not "filed again" -- the fallback
// this repo's own idempotency design depends on.
test("dialogue: a lost comment state falls back to search and reuses the found Issue", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const fingerprint = require("node:crypto")
    .createHash("sha256")
    .update(`${DEFERRED_FINDING.category}|${DEFERRED_FINDING.file}|${DEFERRED_FINDING.line}`)
    .digest("hex")
    .slice(0, 16);

  const { calls } = await runDialogue(fs, os, path_, deferredEnv(), {
    pr: BASE_PR,
    searchResults: [{ number: 777, body: `<!-- llm-review-deferred: ${fingerprint} -->\nold issue` }],
  });

  assert.equal(calls.createIssue.length, 0, "a fingerprint found via search must not be re-filed");
  assert.match(calls.createComment[0].body, /\*\*Tracked in\.\*\* #777/);
});

// Behavior protected: deferredIssues survives the round-reset that zeroes
// round/escalated on a resolved verdict -- these are permanent Issue
// records, not per-round state, and must not be forgotten just because the
// blocking streak ended.
test("dialogue: deferredIssues survives the round/escalated reset on a resolved verdict", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const priorState = { round: 2, headSha: "b".repeat(40), escalated: true, deferredIssues: { abc123: 999 } };
  const existingComment = {
    id: 1,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\n\nprior body`,
  };
  const { calls } = await runDialogue(
    fs,
    os,
    path_,
    {
      RUN_ID: "1",
      RUN_URL: "http://x",
      RUN_HEAD_SHA: HEAD,
      ESCALATE_AFTER: "3",
      HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
      __files: {
        "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
        "review-verdict.json": { verdict: "pass", findings: [], discarded: [], summary: "clean" },
      },
    },
    { pr: BASE_PR, existingComment }
  );

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":0/);
  assert.match(body, /"escalated":false/);
  assert.match(body, /"deferredIssues":\{"abc123":999\}/);
});

// ---------------------------------------------------------------------------
// Confirmed blocking-Issue proposals (packages/review/src/types.ts's
// proposedBlockingIssue field, Issue #316) -- the inverse of outOfScope
// above: the reviewer proposes a NEW blocking Issue, and only once a later
// review round judges the dev/human side as having explicitly confirmed it
// does the dialogue script file it. Never affects the block/pass verdict --
// confirmedProposals is computed independently of blocking/blockingFindings.
// ---------------------------------------------------------------------------

const CONFIRMED_PROPOSAL_FINDING = {
  severity: "advisory",
  category: "security",
  claim: "The webhook handler trusts an unauthenticated payload field.",
  evidence: "const userId = payload.userId;",
  requestedChange: "Verify payload.userId against the authenticated session before using it.",
  citation: "AGENTS.md > Independent LLM Review",
  proposedBlockingIssue: {
    title: "Webhook handler trusts an unauthenticated payload field",
    body: "Tracked separately per the dialogue's agreement -- see the originating pull request for full context.",
    confirmed: true,
  },
};

function confirmedProposalFingerprint(finding = CONFIRMED_PROPOSAL_FINDING) {
  return require("node:crypto").createHash("sha256").update(finding.proposedBlockingIssue.title).digest("hex").slice(0, 16);
}

const CONFIRMED_PROPOSAL_VERDICT = {
  verdict: "pass",
  findings: [CONFIRMED_PROPOSAL_FINDING],
  discarded: [],
  summary: "One finding, proposed and confirmed as its own blocking Issue.",
};

function confirmedProposalEnv(overrides = {}) {
  return {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
      "review-verdict.json": CONFIRMED_PROPOSAL_VERDICT,
    },
    ...overrides,
  };
}

// Behavior protected: a confirmed proposal not yet filed is filed exactly
// once, with the proposal's own title/body, and rendered in a new "Proposed
// blocking Issues" section. Defect caught: never calling issues.create for a
// confirmed proposal, or rendering it inside the blocking/deferred sections
// instead of its own.
test("dialogue: a confirmed proposal not yet filed is filed once and rendered in its own section", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, confirmedProposalEnv(), { pr: BASE_PR });

  assert.equal(calls.createIssue.length, 1, "exactly one Issue must be filed");
  assert.equal(calls.createIssue[0].title, "Webhook handler trusts an unauthenticated payload field");
  assert.deepEqual(calls.createIssue[0].labels, ["source:ai-review"]);
  assert.match(calls.createIssue[0].body, /Tracked separately per the dialogue's agreement/);
  assert.match(calls.createIssue[0].body, /^<!-- llm-review-confirmed-blocking-issue: [0-9a-f]{16} -->/);
  assert.match(calls.createIssue[0].body, /the dev\/human side as having explicitly confirmed/);

  const body = calls.createComment[0].body;
  assert.match(body, /### Proposed blocking Issues \(1\) — confirmed, filed to track/);
  assert.match(body, /\*\*Filed as\.\*\* #300/);
  assert.doesNotMatch(body, /### Deferred findings/);
  assert.doesNotMatch(body, /### Blocking findings/);
});

// NEGATIVE CONTROL / idempotency. Behavior protected: re-running the SAME
// confirmed proposal (same fingerprint) against a comment that already
// recorded it does NOT file a second Issue. Defect caught: filing a new
// Issue on every re-run instead of reusing the recorded number -- the exact
// double-filing this mechanism exists to prevent.
test("dialogue: re-running the same confirmed proposal does not file a duplicate Issue", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const fingerprint = confirmedProposalFingerprint();
  const priorState = { round: 0, headSha: HEAD, escalated: false, confirmedIssues: { [fingerprint]: 555 } };
  const existingComment = {
    id: 1,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\n\nprior body`,
  };

  const { calls } = await runDialogue(fs, os, path_, confirmedProposalEnv(), { pr: BASE_PR, existingComment });

  assert.equal(calls.createIssue.length, 0, "no new Issue may be filed for an already-recorded fingerprint");
  assert.equal(calls.updateComment.length, 1);
  assert.match(calls.updateComment[0].body, /\*\*Filed as\.\*\* #555/);
});

// Behavior protected: state loss (a hand-edited or corrupted managed
// comment) degrades to "found by search," not "filed again" -- same
// fallback discipline as the deferred-Issue loop.
test("dialogue: a lost comment state falls back to search and reuses the found confirmed-proposal Issue", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const fingerprint = confirmedProposalFingerprint();

  const { calls } = await runDialogue(fs, os, path_, confirmedProposalEnv(), {
    pr: BASE_PR,
    searchResults: [{ number: 888, body: `<!-- llm-review-confirmed-blocking-issue: ${fingerprint} -->\nold issue` }],
  });

  assert.equal(calls.createIssue.length, 0, "a fingerprint found via search must not be re-filed");
  assert.match(calls.createComment[0].body, /\*\*Filed as\.\*\* #888/);
});

// NEGATIVE CONTROL. Behavior protected: a proposal with no `confirmed: true`
// (absent, or explicitly false -- a rebuttal, per Issue #316's own negative
// control) must never file anything and must never render the "Proposed
// blocking Issues" section. Defect caught: honoring `confirmed` on anything
// other than a literal `true`, mirroring outOfScope's own fail-safe posture.
test("dialogue: an unconfirmed proposal never files an Issue and never renders the section", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");

  for (const proposedBlockingIssue of [
    { title: "x", body: "y" }, // confirmed absent
    { title: "x", body: "y", confirmed: false }, // explicit rebuttal
    { title: "x", body: "y", confirmed: "true" }, // wrong type, must not be coerced
  ]) {
    const finding = { ...CONFIRMED_PROPOSAL_FINDING, proposedBlockingIssue };
    const verdict = { verdict: "pass", findings: [finding], discarded: [], summary: "not yet confirmed" };
    const { calls } = await runDialogue(
      fs,
      os,
      path_,
      confirmedProposalEnv({
        __files: {
          "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
          "review-verdict.json": verdict,
        },
      }),
      { pr: BASE_PR }
    );

    assert.equal(calls.createIssue.length, 0, `must not file for proposedBlockingIssue=${JSON.stringify(proposedBlockingIssue)}`);
    assert.doesNotMatch(calls.createComment[0].body, /### Proposed blocking Issues/);
  }
});

// NEGATIVE CONTROL. Behavior protected: a malformed or missing
// proposedBlockingIssue never files anything and never throws -- the dialogue
// script must fail closed on uncertain model output, not crash the job.
test("dialogue: a malformed or missing proposedBlockingIssue never files and never throws", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");

  const malformedFindings = [
    { ...CONFIRMED_PROPOSAL_FINDING, proposedBlockingIssue: undefined },
    { ...CONFIRMED_PROPOSAL_FINDING, proposedBlockingIssue: null },
    { ...CONFIRMED_PROPOSAL_FINDING, proposedBlockingIssue: "confirmed" },
    { ...CONFIRMED_PROPOSAL_FINDING, proposedBlockingIssue: { confirmed: true } }, // no title/body
    { ...CONFIRMED_PROPOSAL_FINDING, proposedBlockingIssue: { title: "", body: "y", confirmed: true } }, // empty title
    { ...CONFIRMED_PROPOSAL_FINDING, proposedBlockingIssue: { title: "x", body: "   ", confirmed: true } }, // blank body
  ];

  for (const finding of malformedFindings) {
    const verdict = { verdict: "pass", findings: [finding], discarded: [], summary: "malformed proposal" };
    await assert.doesNotReject(
      runDialogue(
        fs,
        os,
        path_,
        confirmedProposalEnv({
          __files: {
            "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
            "review-verdict.json": verdict,
          },
        }),
        { pr: BASE_PR }
      ),
      `must not throw for proposedBlockingIssue=${JSON.stringify(finding.proposedBlockingIssue)}`
    );
  }
});

// Behavior protected: confirmedIssues survives the round/escalated reset on
// a resolved verdict -- same permanence guarantee as deferredIssues, since
// these are permanent Issue records, not per-round state.
test("dialogue: confirmedIssues survives the round/escalated reset on a resolved verdict", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const priorState = { round: 2, headSha: "b".repeat(40), escalated: true, confirmedIssues: { def456: 111 } };
  const existingComment = {
    id: 1,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\n\nprior body`,
  };
  const { calls } = await runDialogue(
    fs,
    os,
    path_,
    {
      RUN_ID: "1",
      RUN_URL: "http://x",
      RUN_HEAD_SHA: HEAD,
      ESCALATE_AFTER: "3",
      HAS_ANTHROPIC_OAUTH: "true",
      HAS_ANTHROPIC_API_KEY: "true",
      __files: {
        "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
        "review-verdict.json": { verdict: "pass", findings: [], discarded: [], summary: "clean" },
      },
    },
    { pr: BASE_PR, existingComment }
  );

  const body = calls.updateComment[0].body;
  assert.match(body, /"round":0/);
  assert.match(body, /"escalated":false/);
  assert.match(body, /"confirmedIssues":\{"def456":111\}/);
});

// Behavior protected: an outOfScope deferral and a confirmed blocking-Issue
// proposal render in their own independent sections without clobbering each
// other, and each files its own Issue -- proving the two mechanisms (inverse
// of one another by design, per Issue #316) are wired independently rather
// than sharing state that could let one suppress the other.
test("dialogue: a deferred finding and a confirmed proposal both render and file independently in the same run", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const verdict = {
    verdict: "pass",
    findings: [DEFERRED_FINDING, CONFIRMED_PROPOSAL_FINDING],
    discarded: [],
    summary: "one deferred, one confirmed",
  };
  const { calls } = await runDialogue(
    fs,
    os,
    path_,
    confirmedProposalEnv({
      __files: {
        "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
        "review-verdict.json": verdict,
      },
    }),
    { pr: BASE_PR }
  );

  assert.equal(calls.createIssue.length, 2, "both the deferred Issue and the confirmed-proposal Issue must be filed");
  const body = calls.createComment[0].body;
  assert.match(body, /### Deferred findings \(1\) — agreed out of scope, does not block/);
  assert.match(body, /### Proposed blocking Issues \(1\) — confirmed, filed to track/);
});

// ---------------------------------------------------------------------------
// Behavioral: GitHub-native suggested fixes (packages/review/src/types.ts's
// suggestedFix field, Issue #326). A finding may carry a small, mechanical
// replacement; the dialogue renders it as a real, line-anchored PR review
// comment containing a GitHub suggestion block -- the pulls review-comment
// API, never the managed summary comment, which cannot carry line-anchored
// suggestions. When anchoring is impossible (no usable line, or the API
// rejects the anchor) it degrades to a fenced block inside the managed
// comment; delivery never fails over a suggestion. The reviewer only ever
// writes comment content -- applying a suggestion is GitHub's own
// write-gated UI action, so no new permission is involved.
// ---------------------------------------------------------------------------

const SUGGESTED_FIX_FINDING = {
  severity: "advisory",
  category: "test-quality",
  file: "src/pricing.ts",
  line: 42,
  claim: "The discount comparison uses the wrong operator.",
  evidence: "if (discount > 100) {",
  requestedChange: "Use >= so a 100% discount is clamped too.",
  citation: "AGENTS.md > Test quality",
  suggestedFix: {
    file: "src/pricing.ts",
    originalLines: "if (discount > 100) {",
    replacement: "if (discount >= 100) {",
  },
};

function suggestedFixFingerprint(finding = SUGGESTED_FIX_FINDING, headSha = HEAD) {
  return require("node:crypto")
    .createHash("sha256")
    .update(`${headSha}|${finding.suggestedFix.file}|${finding.line ?? ""}|${finding.suggestedFix.replacement}`)
    .digest("hex")
    .slice(0, 16);
}

function suggestedFixEnv(findings, overrides = {}) {
  return {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
      "review-verdict.json": { verdict: "pass", findings, discarded: [], summary: "suggested-fix run" },
    },
    ...overrides,
  };
}

// Behavior protected: the suggestion lands as a REAL line-anchored review
// comment -- pulls.createReviewComment with the head commit, the suggestion's
// own path, the finding's line, side RIGHT, and a GitHub suggestion fence --
// and the managed comment references it rather than inlining a fallback.
// Defect caught: rendering the suggestion only into the managed comment
// (which cannot carry line-anchored suggestions), anchoring to the wrong
// commit or path, or dropping the suggestion fence GitHub's "Apply
// suggestion" UI keys on.
test("dialogue: a suggestedFix with a line posts one line-anchored review comment carrying a GitHub suggestion block", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls } = await runDialogue(fs, os, path_, suggestedFixEnv([SUGGESTED_FIX_FINDING]), { pr: BASE_PR });

  assert.equal(calls.createReviewComment.length, 1, "exactly one review comment must be posted");
  const reviewComment = calls.createReviewComment[0];
  assert.equal(reviewComment.pull_number, 230);
  assert.equal(reviewComment.commit_id, HEAD);
  assert.equal(reviewComment.path, "src/pricing.ts");
  assert.equal(reviewComment.line, 42);
  assert.equal(reviewComment.side, "RIGHT");
  assert.equal("start_line" in reviewComment, false, "a single-line suggestion must not send start_line");
  assert.match(reviewComment.body, /```suggestion\n/);
  assert.match(reviewComment.body, /if \(discount >= 100\) \{/);
  assert.match(reviewComment.body, /apply it only if you agree/);

  const body = calls.createComment[0].body;
  assert.match(body, /\*\*Suggested fix\.\*\* Posted as a line-anchored review comment/);
  assert.doesNotMatch(body, /could not be line-anchored/);
  assert.match(body, new RegExp(`"suggestionComments":\\{"${suggestedFixFingerprint()}":900\\}`), "the posted comment id must be recorded in state");
});

// Behavior protected: a multi-line originalLines anchors as a range --
// start_line at the finding's line, line at its last replaced line -- which
// is what GitHub requires for a multi-line suggestion to be applyable.
test("dialogue: a multi-line suggestedFix anchors as a start_line..line range", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const finding = {
    ...SUGGESTED_FIX_FINDING,
    suggestedFix: { ...SUGGESTED_FIX_FINDING.suggestedFix, originalLines: "if (discount > 100) {\n  discount = 100;", replacement: "if (discount >= 100) {\n  discount = 99;" },
  };
  const { calls } = await runDialogue(fs, os, path_, suggestedFixEnv([finding]), { pr: BASE_PR });

  const reviewComment = calls.createReviewComment[0];
  assert.equal(reviewComment.start_line, 42);
  assert.equal(reviewComment.start_side, "RIGHT");
  assert.equal(reviewComment.line, 43);
});

// Behavior protected: an empty replacement is a deletion -- the suggestion
// fence must contain zero content lines, because a fence containing one empty
// line means "replace with a blank line", a different (and wrong) change.
test("dialogue: an empty-replacement suggestedFix posts a deletion suggestion block with zero content lines", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const finding = {
    ...SUGGESTED_FIX_FINDING,
    suggestedFix: { ...SUGGESTED_FIX_FINDING.suggestedFix, replacement: "" },
  };
  const { calls } = await runDialogue(fs, os, path_, suggestedFixEnv([finding]), { pr: BASE_PR });

  assert.match(calls.createReviewComment[0].body, /```suggestion\n```/);
});

// GRACEFUL DEGRADATION, half one. Behavior protected: a suggestion whose
// finding has no usable line renders as a fenced block inside the managed
// comment instead -- never a review comment (there is nothing to anchor to),
// and never a failure.
test("dialogue: a suggestedFix without a line degrades to a fenced block in the managed comment", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { line, ...findingWithoutLine } = SUGGESTED_FIX_FINDING;
  const { calls } = await runDialogue(fs, os, path_, suggestedFixEnv([findingWithoutLine]), { pr: BASE_PR });

  assert.equal(calls.createReviewComment.length, 0, "nothing to anchor to, so no review-comment attempt");
  assert.equal(calls.createComment.length, 1, "delivery must still happen");
  const body = calls.createComment[0].body;
  assert.match(body, /could not be line-anchored/);
  assert.match(body, /if \(discount >= 100\) \{/);
});

// GRACEFUL DEGRADATION, half two. Behavior protected: the review-comment API
// rejecting the anchor (a line outside the diff is a 422) must not fail
// delivery -- the suggestion falls back into the managed comment and the
// failure is a visible warning, not a crash.
test("dialogue: a rejected line anchor degrades to the managed comment and still delivers", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const { calls, core } = await runDialogue(fs, os, path_, suggestedFixEnv([SUGGESTED_FIX_FINDING]), {
    pr: BASE_PR,
    reviewCommentThrows: true,
  });

  assert.equal(calls.createReviewComment.length, 1, "the anchor must at least be attempted");
  assert.equal(calls.createComment.length, 1, "delivery must survive the rejection");
  const body = calls.createComment[0].body;
  assert.match(body, /could not be line-anchored/);
  assert.match(body, /if \(discount >= 100\) \{/);
  assert.ok(
    core.warnings.some((w) => w.includes("Could not post a line-anchored suggestion")),
    "the degradation must be visible in the run log, not silent"
  );
});

// NEGATIVE CONTROL / idempotency. Behavior protected: a same-head re-run
// whose fingerprint is already recorded in the managed comment's state does
// not post a duplicate review comment -- same discipline as the two
// Issue-filing loops.
test("dialogue: a same-head re-run does not repost an already-recorded suggestion", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const fingerprint = suggestedFixFingerprint();
  const priorState = { round: 0, headSha: HEAD, escalated: false, suggestionComments: { [fingerprint]: 901 } };
  const existingComment = {
    id: 1,
    body: `<!-- agent-engineering-standard:llm-review:v1 -->\n<!-- llm-review-state: ${JSON.stringify(priorState)} -->\n\nprior body`,
  };
  const { calls } = await runDialogue(fs, os, path_, suggestedFixEnv([SUGGESTED_FIX_FINDING]), { pr: BASE_PR, existingComment });

  assert.equal(calls.createReviewComment.length, 0, "an already-recorded suggestion must not be re-posted");
  assert.match(calls.updateComment[0].body, /\*\*Suggested fix\.\*\* Posted as a line-anchored review comment/);
});

// NEGATIVE CONTROL. Behavior protected: a malformed or missing suggestedFix
// never posts a review comment and never throws -- the same fail-safe
// posture as proposedBlockingIssue, since this path holds a write token.
test("dialogue: a malformed or missing suggestedFix never posts a review comment and never throws", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");

  const malformedFindings = [
    { ...SUGGESTED_FIX_FINDING, suggestedFix: undefined },
    { ...SUGGESTED_FIX_FINDING, suggestedFix: null },
    { ...SUGGESTED_FIX_FINDING, suggestedFix: "use >= instead" },
    { ...SUGGESTED_FIX_FINDING, suggestedFix: { originalLines: "x", replacement: "y" } }, // no file
    { ...SUGGESTED_FIX_FINDING, suggestedFix: { file: "a.ts", originalLines: "   ", replacement: "y" } }, // blank anchor
    { ...SUGGESTED_FIX_FINDING, suggestedFix: { file: "a.ts", originalLines: "x" } }, // replacement missing
    { ...SUGGESTED_FIX_FINDING, suggestedFix: { file: "a.ts", originalLines: "x", replacement: 42 } }, // wrong type
  ];

  for (const finding of malformedFindings) {
    let result;
    await assert.doesNotReject(async () => {
      result = await runDialogue(fs, os, path_, suggestedFixEnv([finding]), { pr: BASE_PR });
    }, `must not throw for suggestedFix=${JSON.stringify(finding.suggestedFix)}`);
    assert.equal(result.calls.createReviewComment.length, 0, `must not post for suggestedFix=${JSON.stringify(finding.suggestedFix)}`);
    assert.doesNotMatch(result.calls.createComment[0].body, /Suggested fix/);
  }
});

// STRUCTURAL (Issue #326's permission invariant). Behavior protected: a
// suggestion is comment content, never a commit -- the workflow's own token
// permissions stay contents: read, and the posting script's suggestion path
// goes through the pulls review-comment API with no git-write pathway
// (contents API, commit/ref mutation, merges) anywhere in it. GitHub itself
// enforces that only someone with write access can APPLY a suggestion, so
// keeping this job commit-incapable is what keeps "the reviewer can suggest
// but cannot make the change" true from the repo side.
test("llm-review-dialogue.yml posts suggestions as comment content only: contents stays read-only and no git-write API appears in the script", () => {
  for (const block of permissionsBlocks(dialogueYaml)) {
    assert.doesNotMatch(block, /contents:\s*write/, "no permissions block may grant contents: write");
  }
  const script = extractScript(dialogueYaml, dialogueYaml.indexOf("Dialogue · Post findings"));
  assert.match(script, /pulls\.createReviewComment/, "the suggestion path must use the pulls review-comment API");
  assert.doesNotMatch(script, /createOrUpdateFileContents|deleteFile|createCommit|createOrUpdateRef|updateRef|git\.createRef|repos\.merge/);
});

// ---------------------------------------------------------------------------
// Resolution-by-citation (Issue #325) -- every deliberation turn takes an
// explicit position on the other side's latest evidence, grounded in the
// finding's own citation. The reviewer's half lives in packages/review
// (prompt/schema/validate, tested there); these cover the dev agent's half of
// the structural requirement and the dialogue render surfacing the fields.
// ---------------------------------------------------------------------------

// STRUCTURAL, same evidence class as the footer test above: this proves the
// instruction is PRESENT in the prompt handed to the dispatched agent, not
// that the agent complies. Behavior protected: the dev side of Issue #325's
// two-directional requirement -- every reply opens with an explicit position
// (Agree / Disagree / Other) on the reviewer's most recent citation-grounded
// reasoning, an alternate fix is argued FOR against the cited requirement
// rather than against the reviewer's suggestion, and a repeated position
// with no new citation-grounded reasoning is named as not a real turn.
test("dev-agent-dispatch.yml's prompt instructs the agent to open every reply with an explicit position and argue alternates against the citation", () => {
  const promptStart = dispatchYaml.indexOf("prompt: |");
  assert.ok(promptStart >= 0, "no prompt: | block found");
  const prompt = dispatchYaml.slice(promptStart);
  assert.match(prompt, /\*\*Agree\*\*,\s*\n?\s*\*\*Disagree\*\*, or \*\*Other\*\*/);
  assert.match(prompt, /why it satisfies the cited requirement, not\s*\n?\s*why the reviewer's suggestion is wrong/);
  assert.match(prompt, /repeats a\s*\n?\s*prior position without new citation-grounded reasoning does not\s*\n?\s*count as a real turn/);
});

// Behavior protected: a later-round blocking finding's `deliberation` -- the
// reviewer's explicit position on the dev's latest evidence, the field that
// justifies its continued block -- is rendered in the managed comment, so
// the dev agent and a human can see WHAT was engaged rather than only that
// the block persists. Defect caught: a render that silently drops the field,
// which would make the reviewer's engagement invisible and the dialogue
// look like the bare re-assertion Issue #325 exists to eliminate.
test("dialogue: a blocking finding's deliberation renders as an explicit position on the dev's latest evidence", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const verdict = {
    verdict: "block",
    findings: [
      {
        severity: "blocking",
        category: "test",
        claim: "c",
        evidence: "e",
        requestedChange: "r",
        citation: "AGENTS.md > x",
        deliberation: { position: "disagree", engagesLatestEvidence: "the alternate still lacks invalidation, which the cited criterion requires" },
      },
    ],
    discarded: [],
    summary: "s",
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "failure", verdictPresent: true },
      "review-verdict.json": verdict,
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.match(body, /\*\*Position on the dev's latest evidence\.\*\* `disagree`/);
  assert.match(body, /the alternate still lacks invalidation/);
});

// Behavior protected: a finding validate.ts resolved by default (demoted to
// advisory with resolvedByDefault: true because a later-round continued
// block carried no deliberation) renders with an explicit explanation of WHY
// it no longer blocks -- never silently reshuffled into the advisory list as
// if the reviewer had downgraded it itself. Defect caught: dropping the
// marker, which would make the gate's own intervention indistinguishable
// from reviewer judgment.
test("dialogue: a resolvedByDefault finding renders its resolved-by-default explanation, and the verdict passes", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path_ = await import("node:path");
  const verdict = {
    verdict: "pass",
    findings: [
      {
        severity: "advisory",
        category: "test",
        claim: "re-asserted without engagement",
        evidence: "e",
        requestedChange: "r",
        citation: "AGENTS.md > x",
        resolvedByDefault: true,
      },
    ],
    discarded: [],
    summary: "1 blocking finding(s) were resolved by default.",
  };
  const { calls } = await runDialogue(fs, os, path_, {
    RUN_ID: "1",
    RUN_URL: "http://x",
    RUN_HEAD_SHA: HEAD,
    ESCALATE_AFTER: "3",
    HAS_ANTHROPIC_OAUTH: "true",
    HAS_ANTHROPIC_API_KEY: "true",
    __files: {
      "review-meta.json": { prNumber: 230, baseSha: "b".repeat(40), headSha: HEAD, reviewOutcome: "success", verdictPresent: true },
      "review-verdict.json": verdict,
    },
  }, { pr: BASE_PR });

  const body = calls.createComment[0].body;
  assert.match(body, /\*\*Verdict: `pass`\*\*/);
  assert.match(body, /\*\*Resolved by default\.\*\*/);
  assert.match(body, /Issue #​?325/);
  assert.doesNotMatch(body, /### Blocking findings/);
});
