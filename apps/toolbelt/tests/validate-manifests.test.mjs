import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import {
  TOOLBELT_ROOT,
  SCHEMA_PATH,
  findManifestPaths,
  checkManifestShape,
  checkSchemaOwnershipUniqueness,
  validateAll,
  canonicalize,
  canonicalJSON,
  manifestHash,
  compareRegistry,
  fetchRegistryRows,
} from "../scripts/validate-manifests.mjs";

const VALIDATOR_CLI = join(TOOLBELT_ROOT, "scripts", "validate-manifests.mjs");

function baseManifest(overrides = {}) {
  return {
    id: "sample-tool",
    name: "Sample Tool",
    kind: "cli",
    version: "0.1.0",
    ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt/apps/sample-tool" },
    entry: { cli: { command: "python3 -m sample_tool" } },
    schemas: [],
    permissions: {
      db: { read: [], write: [] },
      networkEgress: [],
      llmHandler: { access: false },
    },
    lifecycle: { migrate: "supabase db push", health: "python3 -m sample_tool --health", register: "pending" },
    ...overrides,
  };
}

// Mirrors the real apps/toolbelt/tool.json this issue authors (see the m3-01
// report for the reasoning behind each judgment-call field).
function rootManifest(overrides = {}) {
  return baseManifest({
    id: "toolbelt",
    name: "Toolbelt Root Spine",
    kind: "headless",
    ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt" },
    entry: { headless: { command: "select core.purge_old_events();", schedule: "0 3 * * *" } },
    schemas: ["core", "idea"],
    permissions: {
      db: { read: ["core", "idea"], write: ["core", "idea"] },
      networkEgress: [],
      llmHandler: { access: false },
    },
    lifecycle: { migrate: "gh workflow run platform-migrations.yml", health: "node --test", register: "pending" },
    ...overrides,
  });
}

// layout: { "tool.json": {...}, "apps/tool-a/tool.json": {...}, ... } ->
// materializes a scratch toolbelt-root tree and hands its path to fn.
function withFixtureRoot(layout, fn) {
  const dir = mkdtempSync(join(tmpdir(), "toolbelt-manifest-fixture-"));
  try {
    for (const [relPath, contents] of Object.entries(layout)) {
      const fullPath = join(dir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [VALIDATOR_CLI, ...args], { encoding: "utf8", ...options });
}

// --- findManifestPaths ------------------------------------------------

test("findManifestPaths finds the root manifest plus each apps/*/tool.json", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a" }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b" }),
    },
    (dir) => {
      const paths = findManifestPaths(dir);
      assert.equal(paths.length, 3);
      assert.ok(paths.every((p) => p.endsWith("tool.json")));
    },
  );
});

test("findManifestPaths tolerates a missing apps/ directory", () => {
  withFixtureRoot({ "tool.json": rootManifest() }, (dir) => {
    assert.equal(findManifestPaths(dir).length, 1);
  });
});

test("findManifestPaths ignores an apps/<id> directory with no tool.json", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a" }),
      "apps/no-manifest/README.md": "nothing to see here",
    },
    (dir) => {
      assert.equal(findManifestPaths(dir).length, 2);
    },
  );
});

// --- checkManifestShape (TB-1a) ----------------------------------------

test("checkManifestShape passes a conforming manifest", () => {
  withFixtureRoot({ "tool.json": rootManifest() }, (dir) => {
    assert.deepEqual(checkManifestShape(findManifestPaths(dir)), []);
  });
});

test("checkManifestShape rejects a manifest with a bad id pattern", () => {
  withFixtureRoot({ "tool.json": rootManifest({ id: "Not-Valid!" }) }, (dir) => {
    const failures = checkManifestShape(findManifestPaths(dir));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /\/id must match pattern/);
  });
});

test("checkManifestShape rejects a manifest whose ownership.owner is not the fixed const", () => {
  withFixtureRoot(
    { "tool.json": rootManifest({ ownership: { owner: "someone-else@example.com", path: "apps/toolbelt" } }) },
    (dir) => {
      const failures = checkManifestShape(findManifestPaths(dir));
      assert.equal(failures.length, 1);
      assert.match(failures[0], /ownership\/owner must be equal to constant/);
    },
  );
});

test("checkManifestShape rejects an invalid networkEgress hostname", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest({
        permissions: {
          db: { read: [], write: [] },
          networkEgress: ["not_a_valid_host!!"],
          llmHandler: { access: false },
        },
      }),
    },
    (dir) => {
      const failures = checkManifestShape(findManifestPaths(dir));
      assert.equal(failures.length, 1);
      assert.match(failures[0], /networkEgress\/0 must match format "hostname"/);
    },
  );
});

test("checkManifestShape reports malformed JSON with a clear message instead of throwing", () => {
  withFixtureRoot({ "tool.json": "{ not json" }, (dir) => {
    const failures = checkManifestShape(findManifestPaths(dir));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /invalid JSON/);
  });
});

// --- checkSchemaOwnershipUniqueness (TB-5) ------------------------------

test("checkSchemaOwnershipUniqueness passes when no two manifests share a schema", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a", schemas: ["alpha"] }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b", schemas: ["beta"] }),
    },
    (dir) => {
      const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
        rootManifestPath: join(dir, "tool.json"),
      });
      assert.deepEqual(failures, []);
    },
  );
});

test("checkSchemaOwnershipUniqueness allows the root spine to own core and idea together", () => {
  withFixtureRoot({ "tool.json": rootManifest() }, (dir) => {
    const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
      rootManifestPath: join(dir, "tool.json"),
    });
    assert.deepEqual(failures, []);
  });
});

test("checkSchemaOwnershipUniqueness (TB-5) fails when two manifests declare the same schema, naming both files", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a", schemas: ["widget"] }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b", schemas: ["widget"] }),
    },
    (dir) => {
      const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
        rootManifestPath: join(dir, "tool.json"),
      });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /schema "widget" is claimed by 2 manifests/);
      assert.match(failures[0], /tool-a[/\\]tool\.json/);
      assert.match(failures[0], /tool-b[/\\]tool\.json/);
    },
  );
});

test("checkSchemaOwnershipUniqueness does not let a non-root manifest ride the root's core/idea exception", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/rogue-tool/tool.json": baseManifest({ id: "rogue-tool", schemas: ["core"] }),
    },
    (dir) => {
      const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
        rootManifestPath: join(dir, "tool.json"),
      });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /schema "core" is claimed by 2 manifests/);
    },
  );
});

// Regression test for a mutation-testing finding (M3): two non-root
// manifests colluding on an exception-eligible schema name ("core"/"idea"),
// with no root manifest present in this fixture at all. A prior
// implementation computed the root exception by filtering owners down to
// "paths that are NOT root" -- proven correct here -- but a single-character
// inversion of that filter (accidentally counting "paths that ARE root"
// instead) silently exempted this exact scenario, because with no root
// manifest present, "zero root-owners" was indistinguishable from "zero
// non-root owners." checkSchemaOwnershipUniqueness no longer special-cases
// root at all (see its own comment), which closes this by construction: any
// 2+ claimants of one schema name are always a collision, full stop.
test("checkSchemaOwnershipUniqueness rejects two non-root manifests colluding on an exception-eligible schema name", () => {
  withFixtureRoot(
    {
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a", schemas: ["core"] }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b", schemas: ["core"] }),
    },
    (dir) => {
      const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
        rootManifestPath: join(dir, "tool.json"), // deliberately does not exist in this fixture
      });
      assert.equal(failures.length, 1);
      assert.match(failures[0], /schema "core" is claimed by 2 manifests/);
      assert.match(failures[0], /tool-a[/\\]tool\.json/);
      assert.match(failures[0], /tool-b[/\\]tool\.json/);
    },
  );
});

// Regression test for a mutation-testing finding (M6): checkSchemaOwnershipUniqueness
// is exported and callable directly (as this suite itself does throughout),
// independent of checkManifestShape. Its `Array.isArray(manifest.schemas)`
// guard exists specifically so a malformed `schemas` field can never reach
// the `for...of` loop below unguarded -- replacing the guard with a bare
// truthiness check (`manifest.schemas || []`) still passed every other test
// in this file, because none of them call this function directly with a
// non-array `schemas`. A non-array, non-iterable value (e.g. a plain object)
// would throw `TypeError: ... is not iterable` and crash the whole
// validateAll/CLI run instead of being cleanly ignored here (checkManifestShape
// separately reports it as a shape failure).
test("checkSchemaOwnershipUniqueness does not throw when a manifest's schemas field is a non-array object", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/malformed-tool/tool.json": baseManifest({ id: "malformed-tool", schemas: { not: "an array" } }),
    },
    (dir) => {
      assert.doesNotThrow(() => {
        const failures = checkSchemaOwnershipUniqueness(findManifestPaths(dir), {
          rootManifestPath: join(dir, "tool.json"),
        });
        // The malformed manifest contributes no schema claims -- it neither
        // collides with root's core/idea nor introduces a phantom owner.
        assert.deepEqual(failures, []);
      });
    },
  );
});

// --- canonicalization / hashing (feeds --registry mode) ------------------

test("canonicalJSON is stable across key order", () => {
  const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
  const b = { a: 2, c: { x: 2, y: 1 }, b: 1 };
  assert.equal(canonicalJSON(a), canonicalJSON(b));
});

test("canonicalize preserves array element order", () => {
  assert.deepEqual(canonicalize({ list: [3, 1, 2] }), { list: [3, 1, 2] });
});

test("manifestHash is deterministic and changes when content changes", () => {
  assert.equal(manifestHash(rootManifest()), manifestHash(rootManifest()));
  assert.notEqual(manifestHash(rootManifest()), manifestHash(rootManifest({ version: "0.2.0" })));
  assert.match(manifestHash(rootManifest()), /^[0-9a-f]{64}$/);
});

// --- validateAll against the real repository manifest set ----------------

test("validateAll passes against the real repository's current manifest set", () => {
  const paths = findManifestPaths(TOOLBELT_ROOT);
  assert.ok(paths.length >= 1);
  const failures = validateAll(paths, { rootManifestPath: join(TOOLBELT_ROOT, "tool.json"), schemaPath: SCHEMA_PATH });
  assert.deepEqual(failures, []);
});

// --- CLI end-to-end (spawns the real script; TB-1a, TB-5) -----------------

test("CLI exits 0 within the TB-1a 5-second budget against the real repository manifest set", () => {
  const startedAt = Date.now();
  const result = runCli([]);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(elapsedMs < 5000, `manifests:check took ${elapsedMs}ms, over the TB-1a 5s budget`);
  assert.match(result.stdout, /Manifest validation passed/);
});

// Finding 42 (independent security review, re-verified against current
// HEAD): --registry now makes a REAL network call to the live Supabase
// project's PostgREST endpoint (fetchRegistryRows/compareRegistry, wired
// into main() below). This test therefore genuinely depends on live
// network reachability, same posture as apps/toolbelt/tests/*.test.mjs's
// own live-Supabase suites (AGENTS.md: "report network or rate-limit
// failures accurately; do not relabel them as passing") -- it does NOT
// hard-assert a specific exit code, because that legitimately depends on
// live infrastructure/credential state this test does not control: this
// sandbox has no TOOLBELT_OWNER_TOKEN, so the CLI falls back to the anon
// key (core.app's RLS restricts reads to the owner, so anon gets zero rows
// -- a real, expected, non-zero exit), and the live project's own schema
// may or may not yet have caught up with core.app.manifest_hash
// independently of anything this test can control (confirmed live in this
// session: it had not, returning a real PostgREST column-does-not-exist
// error -- itself proof the request reached a real server). What IS a
// pure, offline, always-true property of the code -- regardless of live
// state -- is asserted here: the canonical-hash section still prints
// (computed entirely locally, before any network call), the CLI attempts
// a real query and says so, and the old permanently-stubbed message is
// gone. The full comparison LOGIC (missing/extra/route/kind/version/hash
// mismatch, and the zero-rows-is-inconclusive case) is covered
// exhaustively and OFFLINE via a mocked fetchImpl in the compareRegistry/
// fetchRegistryRows unit tests below -- this CLI test only proves the
// wiring, not the logic.
test("CLI --registry prints a canonical sha256 per manifest and attempts a real registry query", () => {
  const result = runCli(["--registry"], { timeout: 20000 });
  assert.match(result.stdout, /sha256=[0-9a-f]{64}/, result.stdout);
  assert.match(result.stdout, /Querying the live registry:/, result.stdout);
  assert.doesNotMatch(result.stdout, /Registry comparison not yet available/);
});

test("CLI (TB-5) exits non-zero over a fixture with a deliberate cross-manifest schema collision", () => {
  withFixtureRoot(
    {
      "tool.json": rootManifest(),
      "apps/tool-a/tool.json": baseManifest({ id: "tool-a", schemas: ["widget"] }),
      "apps/tool-b/tool.json": baseManifest({ id: "tool-b", schemas: ["widget"] }),
    },
    (dir) => {
      const result = runCli(["--root", dir]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /schema "widget" is claimed by 2 manifests/);
    },
  );
});

test("CLI rejects an unrecognized argument with exit code 2", () => {
  const result = runCli(["--bogus"]);
  assert.equal(result.status, 2);
});

// --- compareRegistry / fetchRegistryRows (Finding 42, independent security
// review, re-verified against current HEAD) ------------------------------
//
// Fully offline: compareRegistry is pure, and fetchRegistryRows accepts a
// fetchImpl override so the HTTP call shape is provable without any real
// network access. This is deliberately the exhaustive coverage for the
// comparison LOGIC this fix adds -- the CLI e2e test above only proves the
// wiring reaches a real query; it cannot (honestly) assert pass/fail
// outcomes that depend on live credentials/schema state this sandbox does
// not control.

function uiManifest(overrides = {}) {
  return baseManifest({
    id: "ui-tool",
    kind: "ui",
    entry: { ui: { route: "/widgets" } },
    ...overrides,
  });
}

test("compareRegistry: passes (empty problem list) when every field matches exactly", () => {
  const manifest = uiManifest();
  const remote = { id: "ui-tool", manifest_hash: manifestHash(manifest), route: "/widgets", kind: "ui", version: "0.1.0" };
  assert.deepEqual(compareRegistry([manifest], [remote]), []);
});

test("compareRegistry: flags a registered-locally-but-missing-remotely id", () => {
  const missing = uiManifest();
  // A second, fully-matching local manifest + remote row so remoteRows is
  // non-empty (isolating the per-id "missing" check from the separate
  // zero-rows-total special case, covered on its own below) without also
  // tripping the "extra" check for an unrelated remote row.
  const present = baseManifest({ id: "present-tool" });
  const presentRemote = { id: "present-tool", manifest_hash: manifestHash(present), route: null, kind: "cli", version: "0.1.0" };
  const problems = compareRegistry([missing, present], [presentRemote]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ui-tool: registered locally .* but MISSING/);
});

test("compareRegistry: flags a manifest_hash mismatch", () => {
  const manifest = uiManifest();
  const remote = { id: "ui-tool", manifest_hash: "0".repeat(64), route: "/widgets", kind: "ui", version: "0.1.0" };
  const problems = compareRegistry([manifest], [remote]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /manifest_hash mismatch/);
});

test("compareRegistry: flags a route (path) mismatch, both directions (wrong string, and null-vs-set)", () => {
  const manifest = uiManifest();
  const wrongRoute = { id: "ui-tool", manifest_hash: manifestHash(manifest), route: "/other", kind: "ui", version: "0.1.0" };
  assert.match(compareRegistry([manifest], [wrongRoute])[0], /route \(path\) mismatch/);

  const nullRoute = { id: "ui-tool", manifest_hash: manifestHash(manifest), route: null, kind: "ui", version: "0.1.0" };
  assert.match(compareRegistry([manifest], [nullRoute])[0], /route \(path\) mismatch/);

  // A cli/headless manifest legitimately has no route at all (null on both
  // sides) -- must NOT be flagged.
  const cliManifest = baseManifest({ id: "cli-tool" });
  const cliRemote = { id: "cli-tool", manifest_hash: manifestHash(cliManifest), route: null, kind: "cli", version: "0.1.0" };
  assert.deepEqual(compareRegistry([cliManifest], [cliRemote]), []);
});

test("compareRegistry: flags a kind mismatch and a version mismatch (lifecycle) independently", () => {
  const manifest = uiManifest();
  const wrongKind = { id: "ui-tool", manifest_hash: manifestHash(manifest), route: "/widgets", kind: "cli", version: "0.1.0" };
  const kindProblems = compareRegistry([manifest], [wrongKind]);
  assert.equal(kindProblems.length, 1);
  assert.match(kindProblems[0], /kind \(lifecycle\) mismatch/);

  const wrongVersion = { id: "ui-tool", manifest_hash: manifestHash(manifest), route: "/widgets", kind: "ui", version: "9.9.9" };
  const versionProblems = compareRegistry([manifest], [wrongVersion]);
  assert.equal(versionProblems.length, 1);
  assert.match(versionProblems[0], /version \(lifecycle\) mismatch/);
});

test("compareRegistry: flags a registered-remotely-but-no-local-manifest id (extra)", () => {
  const problems = compareRegistry([], [{ id: "ghost-tool", manifest_hash: null, route: null, kind: "cli", version: "0.0.0" }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ghost-tool: registered in the live registry .* but has no corresponding tool\.json .* \(extra\)/);
});

test("compareRegistry: a genuinely empty local manifest set against zero remote rows is NOT flagged (nothing to compare)", () => {
  assert.deepEqual(compareRegistry([], []), []);
});

// The RLS-visibility honesty case this fix's whole design turns on: zero
// remote rows while local manifests exist must be called out as a distinct,
// explicitly-labeled inconclusive condition (not silently treated as
// definitive proof every id is missing), in ADDITION TO the normal
// missing-id problems it still, correctly, also reports.
test("compareRegistry: zero remote rows with non-empty local manifests reports BOTH the RLS-inconclusive warning AND the missing entries", () => {
  const manifest = uiManifest();
  const problems = compareRegistry([manifest], []);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /ZERO rows while local manifests exist/);
  assert.match(problems[0], /RLS/);
  assert.match(problems[1], /ui-tool: registered locally .* but MISSING/);
});

test("compareRegistry: multiple manifests, only the genuinely differing one is flagged", () => {
  const good = uiManifest({ id: "good-tool" });
  const bad = uiManifest({ id: "bad-tool" });
  const remotes = [
    { id: "good-tool", manifest_hash: manifestHash(good), route: "/widgets", kind: "ui", version: "0.1.0" },
    { id: "bad-tool", manifest_hash: "f".repeat(64), route: "/widgets", kind: "ui", version: "0.1.0" },
  ];
  const problems = compareRegistry([good, bad], remotes);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^bad-tool:/);
});

test("fetchRegistryRows: sends the correct URL, apikey, Accept-Profile, and falls back to the anon key as the bearer when no token is given", async () => {
  let capturedUrl;
  let capturedHeaders;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    return { ok: true, json: async () => [{ id: "x", manifest_hash: "h", route: null, kind: "cli", version: "1.0.0" }] };
  };
  const rows = await fetchRegistryRows({ supabaseUrl: "https://example.supabase.co/", anonKey: "ANON_KEY", fetchImpl: fakeFetch });
  assert.equal(capturedUrl, "https://example.supabase.co/rest/v1/app?select=id,manifest_hash,route,kind,version,status");
  assert.equal(capturedHeaders.apikey, "ANON_KEY");
  assert.equal(capturedHeaders.Authorization, "Bearer ANON_KEY");
  assert.equal(capturedHeaders["Accept-Profile"], "core");
  assert.deepEqual(rows, [{ id: "x", manifest_hash: "h", route: null, kind: "cli", version: "1.0.0" }]);
});

test("fetchRegistryRows: uses the supplied token as the bearer instead of the anon key when given", async () => {
  let capturedHeaders;
  const fakeFetch = async (url, init) => {
    capturedHeaders = init.headers;
    return { ok: true, json: async () => [] };
  };
  await fetchRegistryRows({ supabaseUrl: "https://example.supabase.co", anonKey: "ANON_KEY", token: "OWNER_JWT", fetchImpl: fakeFetch });
  assert.equal(capturedHeaders.Authorization, "Bearer OWNER_JWT");
  assert.equal(capturedHeaders.apikey, "ANON_KEY", "apikey must stay the project anon key even when a real caller token is supplied");
});

test("fetchRegistryRows: throws with the real PostgREST error body on a non-ok response, not a generic/opaque error", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: async () => JSON.stringify({ code: "42703", message: "column app.manifest_hash does not exist" }),
  });
  await assert.rejects(
    () => fetchRegistryRows({ supabaseUrl: "https://example.supabase.co", anonKey: "k", fetchImpl: fakeFetch }),
    /HTTP 400 Bad Request.*column app\.manifest_hash does not exist/s,
  );
});
