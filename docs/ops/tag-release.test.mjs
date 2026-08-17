// Tests for tag-release.sh (issue #189). Real filesystem, a faked curl on
// PATH -- same pattern as restic-setup.test.mjs's resticFakeScript: the
// fake behaves like the real GitHub refs API (200/404 on GET, POST
// creates), not just opaque success, so the script's actual branching is
// exercised.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "tag-release.sh");
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

// tagExists controls the GET (check) response; createFails makes the POST
// (create) exit non-zero, the same way curl --fail does on an HTTP error.
function curlFakeScript(log, { tagExists = false, createFails = false } = {}) {
  return `#!/bin/sh
echo "curl $*" >> "${log}"
is_post=0
for arg in "$@"; do
  if [ "$arg" = "POST" ]; then is_post=1; fi
done
if [ "$is_post" = "1" ]; then
  if [ "${createFails ? 1 : 0}" = "1" ]; then
    exit 22
  fi
  echo '{"ref":"refs/tags/fake"}'
  exit 0
fi
if [ "${tagExists ? 1 : 0}" = "1" ]; then
  printf '200'
else
  printf '404'
fi
exit 0
`;
}

function fakeEnv({ tagExists = false, createFails = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tag-release-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, "curl.log");
  writeFileSync(log, "");
  const curlPath = path.join(bin, "curl");
  writeFileSync(curlPath, curlFakeScript(log, { tagExists, createFails }));
  chmodSync(curlPath, 0o755);
  return { root, bin, log };
}

function run(args, { tagExists = false, createFails = false, env = {} } = {}) {
  const { bin, log } = fakeEnv({ tagExists, createFails });
  const result = spawnSync(script, args, {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: "fake-token",
      REPO: "kgsmith19/hyperbolic-core",
      TAG_RELEASE_DATE: "20260817",
      ...env,
    },
  });
  return { ...result, log: readFileSync(log, "utf8") };
}

test("a real bash -n parse of the script is syntactically clean", () => {
  const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("skips entirely -- no curl calls at all -- when the deploy result is not success", () => {
  for (const badResult of ["failure", "cancelled", "skipped"]) {
    const result = run(["shell", badResult, "abc123def456abc123def456abc123def456abc"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /skip shell/);
    assert.equal(result.log.trim(), "", `no curl call expected for result=${badResult}`);
  }
});

test("creates the tag via a POST to the refs API when it does not already exist", () => {
  const sha = "abc123def456abc123def456abc123def456abc";
  const result = run(["shell", "success", sha], { tagExists: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tagged deploy\/shell\/20260817-abc123def456/);
  const calls = result.log.trim().split("\n");
  assert.equal(calls.length, 2, "expected exactly one GET (check) and one POST (create)");
  assert.match(calls[0], /git\/refs\/tags\/deploy\/shell\/20260817-abc123def456/);
  assert.match(calls[1], /POST/);
  assert.match(calls[1], /git\/refs\b/);
  assert.match(calls[1], /"ref":"refs\/tags\/deploy\/shell\/20260817-abc123def456"/);
  assert.match(calls[1], new RegExp(`"sha":"${sha}"`));
});

test("is idempotent: an already-existing tag makes no create (POST) call at all", () => {
  const sha = "abc123def456abc123def456abc123def456abc";
  const result = run(["shell", "success", sha], { tagExists: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already exists; skipping/);
  const calls = result.log.trim().split("\n");
  assert.equal(calls.length, 1, "expected only the GET (check) call, no POST");
  assert.doesNotMatch(result.log, /POST/);
});

test("the sha in the tag is truncated to 12 characters, not the full 40", () => {
  const sha = "abc123def456abc123def456abc123def456abc";
  const result = run(["llm-handler", "success", sha], { tagExists: false });
  assert.match(result.stdout, /deploy\/llm-handler\/20260817-abc123def456\b/);
  assert.doesNotMatch(result.stdout, /abc123def456abc123/);
});

test("an unexpected HTTP status while checking for the tag fails loudly, not silently", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tag-release-500-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, "curl.log");
  writeFileSync(log, "");
  const curlPath = path.join(bin, "curl");
  writeFileSync(
    curlPath,
    `#!/bin/sh
echo "curl $*" >> "${log}"
printf '500'
exit 0
`,
  );
  chmodSync(curlPath, 0o755);
  const result = spawnSync(script, ["shell", "success", "abc123def456abc123def456abc123def456abc"], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "fake-token", REPO: "kgsmith19/hyperbolic-core", TAG_RELEASE_DATE: "20260817" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected HTTP 500/);
});

test("missing required arguments exit non-zero with a usage message", () => {
  const result = spawnSync(script, [], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: tag-release\.sh/);
});

test("missing GH_TOKEN or REPO env vars exit non-zero rather than making an unauthenticated call", () => {
  const { bin } = fakeEnv({ tagExists: false });
  const noToken = spawnSync(script, ["shell", "success", "abc123def456abc123def456abc123def456abc"], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, REPO: "kgsmith19/hyperbolic-core" },
  });
  assert.notEqual(noToken.status, 0);
  assert.match(noToken.stderr, /GH_TOKEN/);

  const noRepo = spawnSync(script, ["shell", "success", "abc123def456abc123def456abc123def456abc"], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "fake-token" },
  });
  assert.notEqual(noRepo.status, 0);
  assert.match(noRepo.stderr, /REPO/);
});

test("without a TAG_RELEASE_DATE override, the script still runs and produces a real 8-digit UTC date", () => {
  const { bin } = fakeEnv({ tagExists: false });
  const result = spawnSync(script, ["shell", "success", "abc123def456abc123def456abc123def456abc"], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "fake-token", REPO: "kgsmith19/hyperbolic-core" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tagged deploy\/shell\/\d{8}-abc123def456/);
});
