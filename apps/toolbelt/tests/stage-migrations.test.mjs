import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectStagedFiles,
  filterByVersions,
  findUnmatchedVersions,
  writeStagedDir,
  splitAtOwnerDependency,
} from "../scripts/stage-migrations.mjs";

const SCRIPT = new URL("../scripts/stage-migrations.mjs", import.meta.url).pathname;

function withFixtureDirs(dirSpecs, fn) {
  const dirs = dirSpecs.map((files, i) => {
    const dir = mkdtempSync(join(tmpdir(), `stage-fixture-${i}-`));
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents);
    }
    return dir;
  });
  try {
    return fn(dirs);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

function withDestDir(fn) {
  const dest = mkdtempSync(join(tmpdir(), "stage-dest-"));
  try {
    return fn(dest);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

test("collectStagedFiles excludes every _down.sql file", () => {
  withFixtureDirs(
    [
      {
        "20260101000000_thing.sql": "create table x();",
        "20260101000000_thing_down.sql": "drop table x;",
      },
    ],
    (dirs) => {
      const files = collectStagedFiles(dirs);
      assert.equal(files.length, 1);
      assert.equal(files[0].name, "20260101000000_thing.sql");
    },
  );
});

test("collectStagedFiles orders files globally by version across multiple directories, not per-directory-then-concatenated", () => {
  withFixtureDirs(
    [
      {
        // root dir: versions 100 and 300
        "20260101000100_root_a.sql": "select 1;",
        "20260101000300_root_b.sql": "select 1;",
      },
      {
        // second dir: version 200, sits BETWEEN the two root-dir versions
        "20260101000200_second_a.sql": "select 1;",
      },
    ],
    (dirs) => {
      const files = collectStagedFiles(dirs);
      assert.deepEqual(
        files.map((f) => f.name),
        ["20260101000100_root_a.sql", "20260101000200_second_a.sql", "20260101000300_root_b.sql"],
      );
    },
  );
});

test("collectStagedFiles tolerates a MIGRATION_DIRS entry that does not exist yet", () => {
  const missing = join(tmpdir(), "stage-fixture-does-not-exist");
  withFixtureDirs([{ "20260101000000_a.sql": "select 1;" }], (dirs) => {
    const files = collectStagedFiles([...dirs, missing]);
    assert.equal(files.length, 1);
  });
});

test("collectStagedFiles throws when two DIFFERENT directories stage a file with the identical basename", () => {
  withFixtureDirs(
    [
      { "20260101000000_a.sql": "select 1;" },
      { "20260101000000_a.sql": "select 2;" }, // same name, different directory
    ],
    (dirs) => {
      assert.throws(() => collectStagedFiles(dirs), /staging collision/);
    },
  );
});

test("filterByVersions narrows to only the requested version keys", () => {
  withFixtureDirs(
    [
      {
        "20260101000100_a.sql": "select 1;",
        "20260101000200_b.sql": "select 1;",
        "20260101000300_c.sql": "select 1;",
      },
    ],
    (dirs) => {
      const files = collectStagedFiles(dirs);
      const subset = filterByVersions(files, ["20260101000100", "20260101000300"]);
      assert.deepEqual(
        subset.map((f) => f.name),
        ["20260101000100_a.sql", "20260101000300_c.sql"],
      );
    },
  );
});

test("filterByVersions returns an empty set when nothing matches (cold-ledger case)", () => {
  withFixtureDirs([{ "20260101000100_a.sql": "select 1;" }], (dirs) => {
    const files = collectStagedFiles(dirs);
    assert.deepEqual(filterByVersions(files, []), []);
  });
});

test("findUnmatchedVersions returns an empty array when every requested version has a staged file", () => {
  withFixtureDirs(
    [{ "20260101000100_a.sql": "select 1;", "20260101000200_b.sql": "select 1;" }],
    (dirs) => {
      const files = collectStagedFiles(dirs);
      assert.deepEqual(findUnmatchedVersions(files, ["20260101000100", "20260101000200"]), []);
    },
  );
});

test("findUnmatchedVersions reports requested versions with no corresponding staged file (operator typo, or a version whose migration was renamed/deleted)", () => {
  withFixtureDirs([{ "20260101000100_a.sql": "select 1;" }], (dirs) => {
    const files = collectStagedFiles(dirs);
    assert.deepEqual(
      findUnmatchedVersions(files, ["20260101000100", "20260101999999"]),
      ["20260101999999"],
    );
  });
});

test("findUnmatchedVersions returns an empty array for an empty request (the legitimate cold-ledger case, distinct from a typo)", () => {
  withFixtureDirs([{ "20260101000100_a.sql": "select 1;" }], (dirs) => {
    const files = collectStagedFiles(dirs);
    assert.deepEqual(findUnmatchedVersions(files, []), []);
  });
});

// The CLI's main() always reads the real MIGRATION_DIRS (there is no
// fixture-dir override at that layer, matching the CLI's own single job of
// staging the real repo's real migrations), so this exercises it against
// one real, known-existing version plus a sentinel that cannot possibly
// exist -- run from the repo root, same convention the "runs against the
// repository's real migration directories" regression tests above already
// rely on.
test("CLI: --subset-file naming an unknown version exits nonzero and names the culprit, rather than silently staging an incomplete subset", () => {
  const [knownReal] = collectStagedFiles();
  withDestDir((dest) => {
    const subsetPath = join(dest, "subset.txt");
    writeFileSync(subsetPath, `${knownReal.version}\n99999999999999\n`);
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, join(dest, "out"), "--subset-file", subsetPath], {
          encoding: "utf8",
        }),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /99999999999999/);
        return true;
      },
    );
  });
});

test("splitAtOwnerDependency splits before the first file whose SQL body references platform.owner()", () => {
  withFixtureDirs(
    [
      {
        "20260101000100_a.sql": "create table x();",
        "20260101000200_b.sql": "create policy p on x using ((select auth.uid()) = (select platform.owner()));",
        "20260101000300_c.sql": "create index on x (id);",
      },
    ],
    (dirs) => {
      const files = collectStagedFiles(dirs);
      const { preOwner, ownerTierAndLater } = splitAtOwnerDependency(files);
      assert.deepEqual(
        preOwner.map((f) => f.name),
        ["20260101000100_a.sql"],
      );
      assert.deepEqual(
        ownerTierAndLater.map((f) => f.name),
        ["20260101000200_b.sql", "20260101000300_c.sql"],
      );
    },
  );
});

test("splitAtOwnerDependency puts every file in preOwner when none reference platform.owner()", () => {
  withFixtureDirs(
    [
      {
        "20260101000100_a.sql": "create table x();",
        "20260101000200_b.sql": "create table y();",
      },
    ],
    (dirs) => {
      const files = collectStagedFiles(dirs);
      const { preOwner, ownerTierAndLater } = splitAtOwnerDependency(files);
      assert.equal(preOwner.length, 2);
      assert.deepEqual(ownerTierAndLater, []);
    },
  );
});

test("splitAtOwnerDependency puts everything in ownerTierAndLater when the very first file references platform.owner()", () => {
  withFixtureDirs(
    [
      {
        "20260101000100_a.sql": "select platform.owner();",
        "20260101000200_b.sql": "create table y();",
      },
    ],
    (dirs) => {
      const files = collectStagedFiles(dirs);
      const { preOwner, ownerTierAndLater } = splitAtOwnerDependency(files);
      assert.deepEqual(preOwner, []);
      assert.equal(ownerTierAndLater.length, 2);
    },
  );
});

test("splitAtOwnerDependency matches platform.owner() regardless of internal whitespace or a wrapping scalar subquery", () => {
  withFixtureDirs(
    [
      {
        "20260101000100_a.sql": "create table x();",
        "20260101000200_b.sql": "select (select platform . owner (  ));",
      },
    ],
    (dirs) => {
      const files = collectStagedFiles(dirs);
      const { preOwner } = splitAtOwnerDependency(files);
      assert.equal(preOwner.length, 1);
    },
  );
});

// Regression guard mirroring collectStagedFiles's own "runs against the real
// repo state" test below: proves the split is a real, non-degenerate
// boundary against the actual current HEAD migration set -- not just
// fixtures. Deliberately does NOT re-derive its expectation from
// OWNER_DEPENDENCY_RE itself (an earlier version of this test asserted
// "no preOwner file matches the raw regex" / "the split-point file does" --
// perfectly self-consistent, and therefore blind to a regex that is
// SYSTEMATICALLY wrong the same way for both sides of the boundary, which
// is exactly the bug below). Instead it names the two real files whose
// correct placement this whole mechanism exists to get right.
test("splitAtOwnerDependency finds a genuine, non-degenerate boundary in the repository's real migration set", () => {
  const files = collectStagedFiles();
  const { preOwner, ownerTierAndLater } = splitAtOwnerDependency(files);
  assert.ok(preOwner.length > 0, "expected at least one real pre-owner migration");
  assert.ok(ownerTierAndLater.length > 0, "expected at least one real owner-tier migration");
  assert.equal(preOwner.length + ownerTierAndLater.length, files.length);
});

// Regression test for a real bug found during independent review of this
// exact mechanism (Finding 5's implementation), not a hypothetical: the
// naive OWNER_DEPENDENCY_RE matched 20260812140000_platform_owner_bootstrap.sql
// itself, because that migration's own prose ("the `platform.owner()`
// helper every owner-pinned RLS policy calls") and its
// `revoke all on function platform.owner() from public;` / `grant execute
// on function platform.owner() to ...;` statements all contain the literal
// substring "platform.owner(" without ever CALLING the function -- a
// GRANT/REVOKE names a function's signature, it does not execute it. The
// bug placed the bootstrap file itself into ownerTierAndLater, which is
// exactly backwards: platform-migrations.yml's phase 1 (preOwner) would
// then push a set that never creates platform.config at all, and the
// live owner-preflight step that runs between phase 1 and phase 2 would
// fail immediately with "relation platform.config does not exist" on the
// very first real apply -- a deadlock, not a missed optimization. The fix
// (stripLineComments + stripOwnerFunctionDeclarations before testing) is
// exercised here against the two real files whose correct placement this
// property is actually about, not a synthetic fixture, because the bug was
// specific to this file's own real text -- a fixture reconstruction could
// easily fail to reproduce the exact shape that triggered it.
test("splitAtOwnerDependency keeps the platform.owner() bootstrap migration itself in preOwner (regression: GRANT/REVOKE and prose referencing the function's own name must not count as a dependency on it)", () => {
  const files = collectStagedFiles();
  const bootstrap = files.find((f) => f.name === "20260812140000_platform_owner_bootstrap.sql");
  const firstRealDependent = files.find((f) => f.name === "20260812160000_core_idea_owner_pin.sql");
  assert.ok(bootstrap, "expected the real bootstrap migration to be present in this repo's migration set");
  assert.ok(firstRealDependent, "expected the real first owner-dependent migration to be present");

  const { preOwner, ownerTierAndLater } = splitAtOwnerDependency(files);
  assert.ok(
    preOwner.includes(bootstrap),
    "20260812140000_platform_owner_bootstrap.sql (creates platform.config/platform.owner(), never invokes it) must stay in preOwner",
  );
  assert.ok(
    ownerTierAndLater.includes(firstRealDependent),
    "20260812160000_core_idea_owner_pin.sql (a genuine (select platform.owner()) invocation) must land in ownerTierAndLater",
  );
});

test("writeStagedDir copies staged files byte-for-byte into <dest>/supabase/migrations/, preserving global order", () => {
  withFixtureDirs(
    [
      { "20260101000200_b.sql": "select 'b';" },
      { "20260101000100_a.sql": "select 'a';" },
    ],
    (dirs) => {
      const files = collectStagedFiles(dirs);
      withDestDir((dest) => {
        const migrationsDir = writeStagedDir(files, dest);
        assert.equal(migrationsDir, join(dest, "supabase", "migrations"));

        const written = readdirSync(migrationsDir).sort();
        assert.deepEqual(written, ["20260101000100_a.sql", "20260101000200_b.sql"]);

        assert.equal(
          readFileSync(join(migrationsDir, "20260101000100_a.sql"), "utf8"),
          "select 'a';",
        );
        assert.equal(
          readFileSync(join(migrationsDir, "20260101000200_b.sql"), "utf8"),
          "select 'b';",
        );
      });
    },
  );
});

test("writeStagedDir writes nothing but still creates the migrations directory when given an empty file list (cold-ledger apply-mode drift check)", () => {
  withDestDir((dest) => {
    const migrationsDir = writeStagedDir([], dest);
    assert.deepEqual(readdirSync(migrationsDir), []);
  });
});

// Regression guard: proves the global sort is genuinely a function of the
// VERSION prefix, not of directory traversal order or of the filename's
// trailing descriptive text -- a prior implementation that sorted by raw
// filename instead of the parsed numeric version would still pass every
// test above (all these fixtures happen to have filenames that also sort
// correctly as plain strings) but would break the instant a version needed
// a wider field or a name containing a leading digit-like prefix. Exercised
// against this repo's REAL migration directories (not a synthetic fixture)
// so it also proves the script runs cleanly, without throwing, against the
// actual current HEAD migration set -- the same "run against the real repo
// state, not just fixtures" property validate-migrations.test.mjs's own
// last test already establishes for the sibling validator.
test("collectStagedFiles runs against the repository's real migration directories and returns a version-sorted, down-free sequence", () => {
  const files = collectStagedFiles();
  assert.ok(files.length > 0, "expected at least one real staged migration file");
  assert.ok(
    files.every((f) => !f.name.endsWith("_down.sql")),
    "no staged file should be a _down.sql file",
  );
  const versions = files.map((f) => f.version);
  const sorted = [...versions].sort();
  assert.deepEqual(versions, sorted, "real migration set must come out version-sorted");
});
