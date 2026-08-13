import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { withFixtureToolbeltRoot, rootManifest } from "./helpers.mjs";
import {
  toolDirExists,
  findManifestIds,
  findRegisteredIdsOnDisk,
  findSchemaCollisions,
  findShapeFailures,
  detectCollisions,
} from "../src/collisions.mjs";
import { buildManifest } from "../src/templates.mjs";

function candidate(overrides = {}) {
  return buildManifest({
    id: "candidate-tool",
    name: "Candidate Tool",
    kind: "cli",
    route: undefined,
    hasSchema: true,
    schema: "candidate_tool",
    llm: false,
    registerBasename: "20260101000000_register_candidate-tool.sql",
    ...overrides,
  });
}

// --- toolDirExists ---------------------------------------------------------

test("toolDirExists is false for an id with no directory", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    assert.equal(toolDirExists(root, "candidate-tool"), false);
  });
});

test("toolDirExists is true once apps/<id>/ exists", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "apps/candidate-tool/tool.json": candidate() },
    (root) => {
      assert.equal(toolDirExists(root, "candidate-tool"), true);
    },
  );
});

// --- findManifestIds ---------------------------------------------------

test("findManifestIds includes the root spine's own id (apps.toolbelt/tool.json, not under apps/)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const ids = findManifestIds(root);
    assert.ok(ids.has("toolbelt"));
  });
});

test("findManifestIds includes every apps/*/tool.json id", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "apps/tool-a/tool.json": candidate({ id: "tool-a" }) },
    (root) => {
      const ids = findManifestIds(root);
      assert.ok(ids.has("tool-a"));
    },
  );
});

// --- findRegisteredIdsOnDisk ------------------------------------------

test("findRegisteredIdsOnDisk extracts the id from a *_register_<id>.sql basename", () => {
  withFixtureToolbeltRoot(
    { "supabase/migrations/20260101000000_register_prompt-organizer.sql": "-- up\n" },
    (root) => {
      const ids = findRegisteredIdsOnDisk(join(root, "supabase", "migrations"));
      assert.ok(ids.has("prompt-organizer"));
    },
  );
});

test("findRegisteredIdsOnDisk ignores the paired _down.sql file (does not report id 'prompt-organizer_down')", () => {
  withFixtureToolbeltRoot(
    {
      "supabase/migrations/20260101000000_register_prompt-organizer.sql": "-- up\n",
      "supabase/migrations/20260101000000_register_prompt-organizer_down.sql": "-- down\n",
    },
    (root) => {
      const ids = findRegisteredIdsOnDisk(join(root, "supabase", "migrations"));
      assert.deepEqual([...ids], ["prompt-organizer"]);
    },
  );
});

test("findRegisteredIdsOnDisk tolerates a missing migrations directory", () => {
  const ids = findRegisteredIdsOnDisk("/does/not/exist/at/all");
  assert.deepEqual([...ids], []);
});

// --- findSchemaCollisions (reuses checkSchemaOwnershipUniqueness) ---------

test("findSchemaCollisions is empty when the candidate's schema is unclaimed", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    assert.deepEqual(findSchemaCollisions(root, candidate()), []);
  });
});

test("findSchemaCollisions reports a collision when an existing manifest already owns the candidate's schema", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "apps/tool-a/tool.json": candidate({ id: "tool-a", schemas: ["candidate_tool"] }) },
    (root) => {
      const failures = findSchemaCollisions(root, candidate());
      assert.equal(failures.length, 1);
      assert.match(failures[0], /schema "candidate_tool" is claimed by 2 manifests/);
    },
  );
});

test("findSchemaCollisions returns [] for a --no-schema candidate (empty schemas array)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    assert.deepEqual(findSchemaCollisions(root, { ...candidate(), schemas: [] }), []);
  });
});

test("findSchemaCollisions leaves no temp file behind (its own temp dir is always cleaned up)", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("toolbelt-cli-schema-check-"));
    findSchemaCollisions(root, candidate());
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("toolbelt-cli-schema-check-"));
    assert.deepEqual(after, before);
  });
});

// --- findShapeFailures ---------------------------------------------------

test("findShapeFailures is empty for a schema-conforming candidate", () => {
  assert.deepEqual(findShapeFailures(candidate()), []);
});

test("findShapeFailures reports a problem for a deliberately malformed candidate", () => {
  const bad = { ...candidate(), id: "Not Valid!!" };
  const failures = findShapeFailures(bad);
  assert.ok(failures.length > 0);
  assert.match(failures[0], /generated manifest failed its own schema check/);
});

// --- detectCollisions (aggregate) -----------------------------------------

test("detectCollisions is empty for a brand-new, non-colliding id", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    assert.deepEqual(detectCollisions({ toolbeltRoot: root, id: "candidate-tool", candidateManifest: candidate() }), []);
  });
});

test("detectCollisions reports the on-disk-directory collision", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "apps/candidate-tool/tool.json": candidate() },
    (root) => {
      const reasons = detectCollisions({ toolbeltRoot: root, id: "candidate-tool", candidateManifest: candidate() });
      assert.ok(reasons.some((r) => r.includes("already exists on disk")));
    },
  );
});

test("detectCollisions reports the root-spine-manifest-id collision even with no apps/<id>/ directory", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const reasons = detectCollisions({ toolbeltRoot: root, id: "toolbelt", candidateManifest: candidate({ id: "toolbelt" }) });
    assert.ok(reasons.some((r) => r.includes('id "toolbelt" is already claimed')));
  });
});

test("detectCollisions reports the registration-migration-on-disk collision", () => {
  withFixtureToolbeltRoot(
    {
      "tool.json": rootManifest(),
      "supabase/migrations/20260101000000_register_candidate-tool.sql": "-- up\n",
    },
    (root) => {
      const reasons = detectCollisions({ toolbeltRoot: root, id: "candidate-tool", candidateManifest: candidate() });
      assert.ok(reasons.some((r) => r.includes("already has a registration migration")));
    },
  );
});

test("detectCollisions reports the schema collision", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "apps/other-tool/tool.json": candidate({ id: "other-tool", schemas: ["candidate_tool"] }) },
    (root) => {
      const reasons = detectCollisions({ toolbeltRoot: root, id: "candidate-tool", candidateManifest: candidate() });
      assert.ok(reasons.some((r) => r.includes('schema "candidate_tool" is claimed by 2 manifests')));
    },
  );
});

test("detectCollisions can report multiple simultaneous reasons (all checks run, none short-circuits)", () => {
  withFixtureToolbeltRoot(
    {
      "tool.json": rootManifest(),
      "apps/candidate-tool/tool.json": candidate(),
      "supabase/migrations/20260101000000_register_candidate-tool.sql": "-- up\n",
    },
    (root) => {
      const reasons = detectCollisions({ toolbeltRoot: root, id: "candidate-tool", candidateManifest: candidate() });
      assert.ok(reasons.length >= 3, `expected at least 3 simultaneous reasons, got ${reasons.length}: ${JSON.stringify(reasons)}`);
    },
  );
});
