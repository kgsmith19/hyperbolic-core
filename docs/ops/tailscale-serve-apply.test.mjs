// Shape-level tests for docs/ops/tailscale-serve-apply.sh
// (docs/planning/issues/m2-04-feat-shell-serve-routes.md).
//
// What this file CAN prove, in this sandbox, without a real tailnet or a
// `tailscale` binary: the script's --dry-run plan is a deterministic,
// syntactically valid set of `tailscale serve` invocations matching the
// m2-04 route table, and that dry-run mode never shells out to `tailscale`
// at all (so it's safe to preview even on a machine without the CLI
// installed). What this file CANNOT prove, and does not pretend to: that
// running --apply against a real VPS actually converges tailscaled's
// config to this plan. That is an operator task, recorded honestly as such
// in docs/ops/runbook.md -- there is no live tailnet anywhere this test
// suite runs, and faking one (e.g. a stub `tailscale` binary that always
// "succeeds") would only prove the stub works, not the real command shape,
// which is exactly the kind of hollow gate the project's quality bar rules
// out.
//
// Run with: node --test docs/ops/tailscale-serve-apply.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "tailscale-serve-apply.sh");

// A conservative shape check for a `tailscale serve` invocation: the
// literal subcommand, a --bg flag, an --https=<port> flag, a
// --set-path=<path> flag whose path starts with "/", and a non-empty
// target (either an absolute local path or an http:// URL), in that order
// -- matching exactly what the script emits and what Tailscale's own docs
// (tailscale.com/kb/1242) show for the --set-path mount-point form.
const VALID_SERVE_LINE =
  /^tailscale serve --bg --https=\d+ --set-path=\/\S* (\/\S+|https?:\/\/\S+)$/;

function runDryRun(env = process.env) {
  return execFileSync(scriptPath, ["--dry-run"], { encoding: "utf8", env }).trim();
}

test("dry-run plan is non-empty and every line is a syntactically valid `tailscale serve` invocation", () => {
  const output = runDryRun();
  const lines = output.split("\n").filter((l) => l.length > 0);
  assert.ok(lines.length > 0, "expected at least one planned command");
  for (const line of lines) {
    assert.match(line, VALID_SERVE_LINE, `not a valid tailscale serve invocation: ${line}`);
  }
});

test("dry-run plan covers exactly the m2-04 route table: /, /life/, /life/api/", () => {
  const output = runDryRun();
  assert.match(output, /--set-path=\/ \/home\/deploy\/shell\/current/, "missing / -> Shell dist route");
  assert.match(
    output,
    /--set-path=\/life\/ \/home\/deploy\/lifeos-ui\/dist/,
    "missing /life/ -> LifeOS frontend dist route"
  );
  assert.match(
    output,
    /--set-path=\/life\/api\/ http:\/\/127\.0\.0\.1:8000/,
    "missing /life/api/ -> loopback LifeOS API proxy route"
  );
});

test("dry-run plan never configures a target for /brain/stream (reserved, not yet built per m4-21)", () => {
  const output = runDryRun();
  assert.doesNotMatch(
    output,
    /brain/i,
    "the script must not invent a target for /brain/stream; it is reserved in docs/ops/runbook.md only"
  );
});

test("dry-run output is deterministic across repeated invocations (idempotency precondition)", () => {
  const first = runDryRun();
  const second = runDryRun();
  assert.equal(first, second, "the same route table must always produce the same plan, byte for byte");
});

// A minimal, real PATH containing bash/coreutils but (confirmed by hand:
// `which tailscale` exits 1 in this sandbox) no `tailscale` binary
// anywhere on it -- used below to prove dry-run needs no external tool
// beyond bash itself, while still letting bash's own shebang resolve.
const PATH_WITHOUT_TAILSCALE = "/usr/bin:/bin";

test("dry-run mode never shells out to `tailscale` (works even with a PATH that has no tailscale on it)", () => {
  const output = runDryRun({ PATH: PATH_WITHOUT_TAILSCALE });
  const lines = output.split("\n").filter((l) => l.length > 0);
  assert.ok(lines.length === 3, `expected the 3-route plan even without tailscale on PATH, got: ${output}`);
});

test("--apply with no `tailscale` binary on PATH fails loudly instead of silently no-opping", () => {
  // The inverse control of the previous test: --apply MUST try to actually
  // invoke tailscale, so with tailscale absent from PATH it should fail
  // fast with a clear error, not exit 0. This is what proves --dry-run and
  // --apply are genuinely different code paths, not the same no-op dressed
  // up two ways.
  assert.throws(
    () => execFileSync(scriptPath, ["--apply"], { encoding: "utf8", env: { PATH: PATH_WITHOUT_TAILSCALE } }),
    (err) => {
      assert.notEqual(err.status, 0, "expected a non-zero exit code");
      assert.match(err.stderr ?? "", /tailscale/i, "expected an error mentioning the missing tailscale CLI");
      return true;
    }
  );
});

test("an unrecognized flag is rejected rather than silently ignored", () => {
  assert.throws(() => execFileSync(scriptPath, ["--nonsense"], { encoding: "utf8" }), (err) => {
    assert.notEqual(err.status, 0);
    return true;
  });
});
