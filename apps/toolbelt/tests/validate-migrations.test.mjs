import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  checkDownPairing,
  checkBrainSchemaReservation,
  checkOwnerCallWrapping,
  checkVersionCollisions,
  discoverMigrationDirs,
  stripLineComments,
  validateAll,
} from "../scripts/validate-migrations.mjs";

function withFixtureDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "migrations-fixture-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// layout: { "tool.json": {...}, "apps/tool-a/tool.json": {...},
// "apps/tool-a/supabase/migrations/x.sql": "..." } -> materializes a scratch
// toolbelt-root tree and hands its path to fn. Mirrors
// tests/validate-manifests.test.mjs's own withFixtureRoot deliberately (same
// shape, same isolation guarantee: every test below runs against a
// disposable temp directory, never the real apps/toolbelt/ tree).
function withFixtureToolbeltRoot(layout, fn) {
  const dir = mkdtempSync(join(tmpdir(), "migrations-dirs-fixture-"));
  try {
    for (const [relPath, contents] of Object.entries(layout)) {
      const fullPath = join(dir, relPath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rootManifest(overrides = {}) {
  return {
    id: "toolbelt",
    name: "Toolbelt Root Spine",
    kind: "headless",
    version: "0.1.0",
    ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt" },
    entry: { headless: { command: "select 1;", schedule: "0 3 * * *" } },
    schemas: ["core", "idea"],
    permissions: { db: { read: ["core", "idea"], write: ["core", "idea"] }, networkEgress: [], llmHandler: { access: false } },
    lifecycle: { migrate: "gh workflow run platform-migrations.yml", health: "node --test", register: "pending" },
    ...overrides,
  };
}

function schemaOwningManifest(id, overrides = {}) {
  return {
    id,
    name: id,
    kind: "cli",
    version: "0.1.0",
    ownership: { owner: "kylegsmith19@gmail.com", path: `apps/toolbelt/apps/${id}` },
    entry: { cli: { command: "true" } },
    schemas: [id.replaceAll("-", "_")],
    permissions: { db: { read: [], write: [] }, networkEgress: [], llmHandler: { access: false } },
    lifecycle: { migrate: "supabase db push", health: "true", register: "pending" },
    ...overrides,
  };
}

function noSchemaManifest(id, overrides = {}) {
  return schemaOwningManifest(id, { schemas: [], ...overrides });
}

// --- discoverMigrationDirs (Finding 26) ------------------------------------
//
// Finding 26 (independent security review of this repo, re-verified against
// current HEAD): "Scaffolding emits nested migrations, but workflow and
// validator hard-code known app directories... Discover manifest-owned
// migration directories deterministically." This is the red-to-green proof
// that a newly scaffolded tool's own migrations directory was a REAL,
// previously uncaught gap under the old fixed 3-entry list, and that the
// new discovery function closes it with zero manual edits required.

// Reconstructs exactly what the OLD hardcoded MIGRATION_DIRS literal was
// (verbatim, from git history / the pre-fix source): the root spine, Prompt
// Organizer, and Idea Intake -- and nothing else, ever, regardless of what
// else gets scaffolded on disk later. This is the "before" side of the
// red-to-green proof below: a function that can never see a fourth
// directory no matter what exists on disk, by construction.
function oldHardcodedMigrationDirs(toolbeltRoot) {
  return [
    join(toolbeltRoot, "supabase", "migrations"),
    join(toolbeltRoot, "apps", "prompt-organizer", "supabase", "migrations"),
    join(toolbeltRoot, "apps", "idea-intake", "supabase", "migrations"),
  ];
}

test("RED: the old hardcoded 3-entry migration-dir list misses a newly scaffolded schema-owning tool's own migrations directory", () => {
  withFixtureToolbeltRoot(
    {
      "tool.json": rootManifest(),
      "apps/prompt-organizer/tool.json": schemaOwningManifest("prompt-organizer"),
      "apps/idea-intake/tool.json": schemaOwningManifest("idea-intake"),
      // A brand-new tool, scaffolded via `tool:new --schema` per the CLI's
      // own promised 3-step flow: its own tool.json (schemas non-empty) and
      // its own supabase/migrations/ directory exist together on disk, with
      // zero framework file ever edited by hand.
      "apps/brand-new-tool/tool.json": schemaOwningManifest("brand-new-tool"),
      "apps/brand-new-tool/supabase/migrations/20260901000000_brand_new_tool_create_schema.sql": "create schema brand_new_tool;",
    },
    (root) => {
      const oldDirs = oldHardcodedMigrationDirs(root);
      const newToolDir = join(root, "apps", "brand-new-tool", "supabase", "migrations");
      assert.ok(
        !oldDirs.includes(newToolDir),
        "the old hardcoded list can never contain a freshly scaffolded tool's directory -- this is exactly Finding 26's gap",
      );
      // Concretely: validateAll/checkVersionCollisions run against the OLD
      // list would never even list the new tool's migration file, let alone
      // validate it -- confirmed by running listSqlFiles-equivalent logic
      // directly: none of the old dirs is the new tool's directory, so no
      // scan of `oldDirs` can ever read that file.
    },
  );
});

test("GREEN: discoverMigrationDirs finds the same newly scaffolded tool's migrations directory automatically", () => {
  withFixtureToolbeltRoot(
    {
      "tool.json": rootManifest(),
      "apps/prompt-organizer/tool.json": schemaOwningManifest("prompt-organizer"),
      "apps/idea-intake/tool.json": schemaOwningManifest("idea-intake"),
      "apps/brand-new-tool/tool.json": schemaOwningManifest("brand-new-tool"),
      "apps/brand-new-tool/supabase/migrations/20260901000000_brand_new_tool_create_schema.sql": "create schema brand_new_tool;",
    },
    (root) => {
      const dirs = discoverMigrationDirs(root);
      const newToolDir = join(root, "apps", "brand-new-tool", "supabase", "migrations");
      assert.ok(dirs.includes(newToolDir), "expected discoverMigrationDirs to find the newly scaffolded tool's own migrations directory");

      // And it is not just discovered but actually validated: a real
      // problem inside that new tool's migration set (a missing down file)
      // is now caught, exactly the CI-gate gap Finding 26 describes ("npm
      // run manifests:check never validates the new tool's migrations").
      const failures = validateAll(dirs);
      assert.ok(
        failures.some((f) => f.includes("brand-new-tool") && f.includes("missing paired down migration")),
        `expected validateAll to catch the new tool's missing down migration, got: ${JSON.stringify(failures)}`,
      );
    },
  );
});

test("discoverMigrationDirs finds exactly the root spine, prompt-organizer, and idea-intake directories for a fixture matching the real repo's shape", () => {
  withFixtureToolbeltRoot(
    {
      "tool.json": rootManifest(),
      "apps/prompt-organizer/tool.json": schemaOwningManifest("prompt-organizer"),
      "apps/idea-intake/tool.json": schemaOwningManifest("idea-intake"),
    },
    (root) => {
      const dirs = discoverMigrationDirs(root).sort();
      assert.deepEqual(dirs, [
        join(root, "apps", "idea-intake", "supabase", "migrations"),
        join(root, "apps", "prompt-organizer", "supabase", "migrations"),
        join(root, "supabase", "migrations"),
      ].sort());
    },
  );
});

// Regression guard for the exact reasoning that makes this discriminator
// correct rather than a naive "walk every supabase/migrations directory"
// scan: a real, already-existing tool with its OWN supabase/migrations/
// directory (network-checker's actual precedent on disk, see this
// function's own doc comment in scripts/validate-migrations.mjs) but an
// EMPTY `schemas` array -- meaning it owns no schema in the shared platform
// database, its Supabase project is a deliberately separate one -- must
// stay excluded, exactly like network-checker itself does in the real repo.
test("discoverMigrationDirs excludes a tool with its own supabase/migrations/ directory but an empty schemas array (mirrors the real network-checker precedent)", () => {
  withFixtureToolbeltRoot(
    {
      "tool.json": rootManifest(),
      "apps/no-schema-tool/tool.json": noSchemaManifest("no-schema-tool"),
      "apps/no-schema-tool/supabase/migrations/0001_init.sql": "create table x();",
    },
    (root) => {
      const dirs = discoverMigrationDirs(root);
      const excludedDir = join(root, "apps", "no-schema-tool", "supabase", "migrations");
      assert.ok(
        !dirs.includes(excludedDir),
        "a schema-less tool's own migrations directory must stay excluded from the shared platform namespace",
      );
    },
  );
});

test("discoverMigrationDirs tolerates a manifest whose migrations directory does not exist yet on disk", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const dirs = discoverMigrationDirs(root);
    assert.deepEqual(dirs, [join(root, "supabase", "migrations")]);
  });
});

test("discoverMigrationDirs skips a manifest that fails to parse as JSON, rather than throwing", () => {
  withFixtureToolbeltRoot(
    {
      "tool.json": rootManifest(),
      "apps/broken-tool/tool.json": "{ not valid json",
    },
    (root) => {
      assert.doesNotThrow(() => discoverMigrationDirs(root));
      const dirs = discoverMigrationDirs(root);
      assert.ok(!dirs.includes(join(root, "apps", "broken-tool", "supabase", "migrations")));
    },
  );
});

test("discoverMigrationDirs against the real repository finds exactly the three real schema-owning migration directories (network-checker still excluded)", () => {
  const dirs = discoverMigrationDirs().map((d) => d.replaceAll("\\", "/"));
  assert.ok(dirs.some((d) => d.endsWith("apps/toolbelt/supabase/migrations")));
  assert.ok(dirs.some((d) => d.endsWith("apps/toolbelt/apps/prompt-organizer/supabase/migrations")));
  assert.ok(dirs.some((d) => d.endsWith("apps/toolbelt/apps/idea-intake/supabase/migrations")));
  assert.ok(
    !dirs.some((d) => d.includes("network-checker")),
    "network-checker owns no schema in the shared platform project and must stay excluded, per its own registration migration's documented rationale",
  );
  assert.equal(dirs.length, 3);
});

test("checkDownPairing passes when every up has a down", () => {
  withFixtureDir(
    {
      "20260101000000_thing.sql": "create table x();",
      "20260101000000_thing_down.sql": "drop table x;",
    },
    (dir) => {
      assert.deepEqual(checkDownPairing([dir]), []);
    },
  );
});

test("checkDownPairing fails when an up migration has no paired down", () => {
  withFixtureDir(
    {
      "20260101000000_thing.sql": "create table x();",
    },
    (dir) => {
      const failures = checkDownPairing([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /missing paired down migration/);
    },
  );
});

test("checkBrainSchemaReservation passes for unrelated schemas", () => {
  withFixtureDir(
    { "20260101000000_thing.sql": "create schema idea;" },
    (dir) => {
      assert.deepEqual(checkBrainSchemaReservation([dir]), []);
    },
  );
});

// Regression: caught by mutation testing, not by inspection. Dropping the
// \b word-boundary anchor from BRAIN_SCHEMA_RE survived the rest of this
// suite untouched, which meant nothing actually proved "brain" is matched
// as a whole schema name rather than a prefix. A tool legitimately named
// "brainstorm" (or any brain-prefixed name) must not be blocked by the
// brain reservation, which is exactly "brain" and nothing else.
test("checkBrainSchemaReservation does not flag a schema name that merely starts with 'brain'", () => {
  withFixtureDir(
    { "20260101000000_thing.sql": "create schema brainstorm;" },
    (dir) => {
      assert.deepEqual(checkBrainSchemaReservation([dir]), []);
    },
  );
});

// Regression: found by adversarial property-test design, not by inspection.
// A comment merely mentioning the reservation must not itself trip the
// lint -- only executable DDL creates a schema. The original implementation
// scanned raw file content, so this case failed until comment-stripping was
// added (see scripts/validate-migrations.mjs, checkBrainSchemaReservation).
test("checkBrainSchemaReservation ignores a comment that only mentions creating the brain schema", () => {
  withFixtureDir(
    {
      "20260101000000_thing.sql":
        "-- reminder: never create schema brain here, it is reserved for phase 7\nselect 1;",
    },
    (dir) => {
      assert.deepEqual(checkBrainSchemaReservation([dir]), []);
    },
  );
});

test("checkBrainSchemaReservation fails when a file creates the brain schema", () => {
  withFixtureDir(
    { "20260101000000_thing.sql": "create schema brain;" },
    (dir) => {
      const failures = checkBrainSchemaReservation([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /reserved 'brain' schema/);
    },
  );
  withFixtureDir(
    { "20260101000000_thing.sql": "CREATE SCHEMA IF NOT EXISTS brain;" },
    (dir) => {
      assert.equal(checkBrainSchemaReservation([dir]).length, 1);
    },
  );
});

// --- Finding 45 (independent security review, re-verified against current
// HEAD): stripLineComments string-literal/block-comment awareness, and
// BRAIN_SCHEMA_RE's double-quoted-identifier blind spot. Adversarial cases
// the review itself names.

test("checkBrainSchemaReservation (Finding 45): a double-quoted \"brain\" identifier creates the identical real, lowercase reserved schema and must be flagged", () => {
  withFixtureDir(
    { "20260101000000_thing.sql": 'create schema "brain";' },
    (dir) => {
      const failures = checkBrainSchemaReservation([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /reserved 'brain' schema/);
    },
  );
});

test("checkBrainSchemaReservation (Finding 45): quoted \"brain\" combined with IF NOT EXISTS is still flagged", () => {
  withFixtureDir(
    { "20260101000000_thing.sql": 'create schema if not exists "brain";' },
    (dir) => {
      assert.equal(checkBrainSchemaReservation([dir]).length, 1);
    },
  );
});

// Postgres folds an UNQUOTED identifier to lowercase regardless of how it
// was typed, but takes a QUOTED identifier verbatim, case-sensitively --
// "Brain" and "BRAIN" name genuinely different, non-reserved schemas, not
// the reserved lowercase brain. Normalizing every double-quoted identifier
// indiscriminately (rather than only the exact literal "brain") would turn
// this into a false positive.
test("checkBrainSchemaReservation (Finding 45): a differently-cased double-quoted identifier is a genuinely different schema and must NOT be flagged", () => {
  withFixtureDir(
    { "20260101000000_thing.sql": 'create schema "Brain";' },
    (dir) => {
      assert.deepEqual(checkBrainSchemaReservation([dir]), []);
    },
  );
  withFixtureDir(
    { "20260101000000_thing.sql": 'create schema "BRAIN";' },
    (dir) => {
      assert.deepEqual(checkBrainSchemaReservation([dir]), []);
    },
  );
});

// Regression: the pre-fix implementation located "--" by naive
// String.indexOf with no string-literal awareness at all, so a single-quoted
// value containing the two characters "--" truncated the rest of that
// physical line -- including any REAL, executable SQL following it, such as
// a bare platform.owner() call this lint exists to catch. This is a lint
// BYPASS, not just a cosmetic miss: before the fix, this exact fixture
// produced zero failures despite containing a genuine violation.
test("checkOwnerCallWrapping (Finding 45): a single-quoted string containing '--' does not hide a real bare call later on the same line", () => {
  withFixtureDir(
    { "20260101000000_policy.sql": "select 'a--b', platform.owner();" },
    (dir) => {
      const failures = checkOwnerCallWrapping([dir]);
      assert.equal(failures.length, 1, "the bare call after the string literal must still be detected, not silently swallowed");
      assert.match(failures[0], /bare platform\.owner\(\) call/);
    },
  );
});

// Regression: '' (doubled single quote) is the standard SQL in-string escape
// for a literal quote character. Mishandling it (e.g. treating the first of
// the pair as the string's real closing quote) desynchronizes the scanner's
// notion of "inside a string" for everything that follows, which can leave
// real code downstream misclassified as still being inside a string --
// hiding it from every other check in this file, not just this one.
test("checkOwnerCallWrapping (Finding 45): '' (doubled-quote) escaping inside a string does not desynchronize detection of a later bare call", () => {
  withFixtureDir(
    { "20260101000000_policy.sql": "select 'it''s fine', platform.owner();" },
    (dir) => {
      const failures = checkOwnerCallWrapping([dir]);
      assert.equal(failures.length, 1, "incorrect '' handling would leave the scanner stuck 'inside a string', hiding the real bare call");
    },
  );
});

// Regression: no block-comment handling at all existed before the fix. A
// bare call written only as commentary/example text inside /* */ must not
// be flagged (it is not executable SQL), and -- the sharper half of this
// property -- real code immediately after the comment closes must still be
// seen and checked, proving the comment's own end boundary is recognized
// correctly rather than swallowing the rest of the file.
test("checkOwnerCallWrapping (Finding 45): block comments are stripped -- a bare call only inside /* */ is ignored, but a real call after the comment still is caught", () => {
  withFixtureDir(
    {
      "20260101000000_policy.sql":
        "/* old approach called platform.owner() directly, changed below */\ncreate policy owner_rw on core.run using (user_id = platform.owner());",
    },
    (dir) => {
      const failures = checkOwnerCallWrapping([dir]);
      assert.equal(failures.length, 1, "only the real bare call outside the comment should be flagged");
    },
  );
});

// Postgres nests block comments for real ("/* /* */ */" is one complete
// comment, not a syntax error followed by stray code) -- a naive
// first-"*/"-closes scanner would treat the INNER "*/" as ending the whole
// comment, leaving " still outer */" misread as live code.
test("checkOwnerCallWrapping (Finding 45): nested block comments are stripped as one unit, matching Postgres's own nesting behavior", () => {
  withFixtureDir(
    {
      "20260101000000_policy.sql":
        "/* outer /* inner platform.owner() */ still outer */\nselect platform.owner();",
    },
    (dir) => {
      const failures = checkOwnerCallWrapping([dir]);
      assert.equal(failures.length, 1, "only the real call after both comment layers close should be flagged");
    },
  );
});

// Direct proof on stripLineComments's own output, not just a downstream
// failure count: a scanner that treats the FIRST "*/" as closing the whole
// nested comment (rather than tracking depth) leaks everything from that
// first "*/" onward -- including the literal "*/ still outer */" text --
// into the stripped result as if it were live code. That specific leaked
// fixture happens to still contain exactly one real platform.owner() call
// (the trailing "select platform.owner();"), so the failure-count
// assertion above alone cannot distinguish correct nesting from this
// broken-but-coincidentally-same-count behavior; asserting the exact
// stripped text closes that gap.
test("stripLineComments (Finding 45): a nested block comment is removed in its entirety, leaving no leaked fragment of its own closing markers", () => {
  const sql = "/* outer /* inner platform.owner() */ still outer */\nselect platform.owner();";
  assert.equal(stripLineComments(sql), "\nselect platform.owner();");
});

// Line numbers in this lint's own failure messages must stay accurate even
// across a stripped multi-line block comment (checkOwnerCallWrapping reports
// "<file>:<line>: bare platform.owner() call...", and a wrong line number
// would send a reviewer to the wrong place in a real migration).
test("checkOwnerCallWrapping (Finding 45): line numbers stay accurate across a stripped multi-line block comment", () => {
  withFixtureDir(
    { "20260101000000_policy.sql": "/* line1\nline2\nline3 */\nselect platform.owner();" },
    (dir) => {
      const failures = checkOwnerCallWrapping([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /:4: bare platform\.owner\(\) call/);
    },
  );
});

test("checkOwnerCallWrapping passes when platform.owner() is wrapped in a scalar subquery", () => {
  withFixtureDir(
    {
      "20260101000000_policy.sql":
        "create policy owner_rw on core.run using (user_id = (select platform.owner()));",
    },
    (dir) => {
      assert.deepEqual(checkOwnerCallWrapping([dir]), []);
    },
  );
});

test("checkOwnerCallWrapping fails on a bare platform.owner() call", () => {
  withFixtureDir(
    {
      "20260101000000_policy.sql":
        "create policy owner_rw on core.run using (user_id = platform.owner());",
    },
    (dir) => {
      const failures = checkOwnerCallWrapping([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /bare platform\.owner\(\) call/);
    },
  );
});

test("checkOwnerCallWrapping ignores mentions inside line comments", () => {
  withFixtureDir(
    {
      "20260101000000_policy.sql":
        "-- calls platform.owner() to resolve the pin\ncreate policy owner_rw on core.run using (user_id = (select platform.owner()));",
    },
    (dir) => {
      assert.deepEqual(checkOwnerCallWrapping([dir]), []);
    },
  );
});

test("checkOwnerCallWrapping ignores the function's own CREATE/DROP/GRANT/REVOKE signature", () => {
  withFixtureDir(
    {
      "20260101000000_bootstrap.sql": [
        "create function platform.owner() returns uuid",
        "language sql stable security definer",
        "as $$ select owner_uuid from platform.config $$;",
        "revoke all on function platform.owner() from public;",
        "grant execute on function platform.owner() to anon, authenticated;",
      ].join("\n"),
      "20260101000000_bootstrap_down.sql": "drop function if exists platform.owner();",
    },
    (dir) => {
      assert.deepEqual(checkOwnerCallWrapping([dir]), []);
    },
  );
});

test("checkVersionCollisions passes for unique version keys", () => {
  withFixtureDir(
    {
      "20260101000000_a.sql": "select 1;",
      "20260101000001_b.sql": "select 1;",
    },
    (dir) => {
      assert.deepEqual(checkVersionCollisions([dir]), []);
    },
  );
});

test("checkVersionCollisions passes for a legitimate up/down pair sharing a timestamp", () => {
  withFixtureDir(
    {
      "20260101000000_thing.sql": "create table x();",
      "20260101000000_thing_down.sql": "drop table x;",
    },
    (dir) => {
      assert.deepEqual(checkVersionCollisions([dir]), []);
    },
  );
});

test("checkVersionCollisions fails when two DIFFERENT migrations share a version key", () => {
  withFixtureDir(
    {
      "20260101000000_a.sql": "select 1;",
      "20260101000000_b.sql": "select 1;",
    },
    (dir) => {
      const failures = checkVersionCollisions([dir]);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /shared by 2 distinct migrations/);
    },
  );
});

test("checkVersionCollisions detects collisions across multiple directories", () => {
  const dirA = mkdtempSync(join(tmpdir(), "migrations-fixture-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "migrations-fixture-b-"));
  try {
    writeFileSync(join(dirA, "20260101000000_a.sql"), "select 1;");
    writeFileSync(join(dirB, "20260101000000_b.sql"), "select 1;");
    const failures = checkVersionCollisions([dirA, dirB]);
    assert.equal(failures.length, 1);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("validateAll tolerates a migration directory that does not exist yet", () => {
  const missing = join(tmpdir(), "does-not-exist-migrations-dir-fixture");
  assert.deepEqual(validateAll([missing]), []);
});

test("validateAll passes against the repository's real migration directories", () => {
  const failures = validateAll();
  assert.deepEqual(failures, []);
});
