// Exercises main() (src/cli.mjs) directly, with captured stdout/stderr,
// against disposable fixture toolbelt roots via the internal
// --toolbelt-root flag. Faster than spawning a subprocess for every case;
// tests/cli.integration.test.mjs covers the real subprocess/bin.tool.mjs
// path end-to-end separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withFixtureToolbeltRoot, rootManifest, snapshotTree } from "./helpers.mjs";
import { main } from "../src/cli.mjs";

function capture() {
  const out = [];
  const err = [];
  return {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    outText: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

test("main() exits 0 and creates the full layout for a valid ui invocation", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const cap = capture();
    const code = main(
      ["--toolbelt-root", root, "--id", "scratch-tool", "--name", "Scratch", "--kind", "ui", "--route", "/scratch"],
      cap,
    );
    assert.equal(code, 0);
    assert.ok(existsSync(join(root, "apps", "scratch-tool", "tool.json")));
    assert.match(cap.outText(), /generated apps\/toolbelt\/apps\/scratch-tool\//);
  });
});

test("main() exits 2 with a usage message for an unrecognized flag, writing nothing", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    const cap = capture();
    const code = main(["--toolbelt-root", root, "--bogus"], cap);
    assert.equal(code, 2);
    assert.match(cap.errText(), /unrecognized argument/);
    assert.deepEqual(snapshotTree(root), before);
  });
});

test("main() exits 2 for a missing required flag, writing nothing", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    const cap = capture();
    const code = main(["--toolbelt-root", root, "--id", "scratch-tool"], cap);
    assert.equal(code, 2);
    assert.match(cap.errText(), /invalid arguments/);
    assert.deepEqual(snapshotTree(root), before);
  });
});

test("main() exits 2 for a bad flag combination (--route with --kind cli), writing nothing", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    const cap = capture();
    const code = main(
      ["--toolbelt-root", root, "--id", "scratch-tool", "--name", "Scratch", "--kind", "cli", "--route", "/nope"],
      cap,
    );
    assert.equal(code, 2);
    assert.deepEqual(snapshotTree(root), before);
  });
});

test("main() exits 2 for an id collision (already exists on disk), writing nothing", () => {
  withFixtureToolbeltRoot(
    { "tool.json": rootManifest(), "apps/scratch-tool/tool.json": { id: "scratch-tool" } },
    (root) => {
      const before = snapshotTree(root);
      const cap = capture();
      const code = main(
        ["--toolbelt-root", root, "--id", "scratch-tool", "--name", "Scratch", "--kind", "cli"],
        cap,
      );
      assert.equal(code, 2);
      assert.match(cap.errText(), /already exists on disk/);
      assert.deepEqual(snapshotTree(root), before);
    },
  );
});

test("main() exits 2 for a schema collision, writing nothing", () => {
  withFixtureToolbeltRoot(
    {
      "tool.json": rootManifest(),
      "apps/other-tool/tool.json": {
        id: "other-tool",
        name: "Other",
        kind: "cli",
        version: "0.1.0",
        ownership: { owner: "kylegsmith19@gmail.com", path: "apps/toolbelt/apps/other-tool" },
        entry: { cli: { command: "echo hi" } },
        schemas: ["scratch_tool"],
        permissions: { db: { read: [], write: [] }, networkEgress: [], llmHandler: { access: false } },
        lifecycle: { migrate: "none", health: "true", register: "pending" },
      },
    },
    (root) => {
      const before = snapshotTree(root);
      const cap = capture();
      const code = main(
        ["--toolbelt-root", root, "--id", "scratch-tool", "--name", "Scratch", "--kind", "cli"],
        cap,
      );
      assert.equal(code, 2);
      assert.match(cap.errText(), /schema "scratch_tool" is claimed by 2 manifests/);
      assert.deepEqual(snapshotTree(root), before);
    },
  );
});

test("main() --dry-run exits 0, prints the plan, and writes nothing", () => {
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    const cap = capture();
    const code = main(
      ["--toolbelt-root", root, "--id", "scratch-tool", "--name", "Scratch", "--kind", "cli", "--dry-run"],
      cap,
    );
    assert.equal(code, 0);
    assert.match(cap.outText(), /--dry-run: plan for apps\/toolbelt\/apps\/scratch-tool\//);
    assert.match(cap.outText(), /would create.*tool\.json/);
    assert.deepEqual(snapshotTree(root), before);
  });
});

test("main() rolls back and exits 1 when the write phase itself fails unexpectedly", () => {
  // Injects a real filesystem-call failure partway through the write loop
  // via the internal fsImpl passthrough (permission-bit tricks are not a
  // reliable way to force an EACCES in this sandbox, which runs as root and
  // therefore bypasses them) -- see tests/scaffold.test.mjs for the same
  // technique applied directly against writePlan.
  withFixtureToolbeltRoot({ "tool.json": rootManifest() }, (root) => {
    const before = snapshotTree(root);
    let count = 0;
    const failingFsImpl = {
      mkdirSync,
      writeFileSync: (path, content) => {
        count += 1;
        if (count === 2) throw new Error("injected write failure");
        writeFileSync(path, content);
      },
      rmSync,
    };

    const cap = capture();
    const code = main(
      ["--toolbelt-root", root, "--id", "scratch-tool", "--name", "Scratch", "--kind", "cli"],
      { ...cap, fsImpl: failingFsImpl },
    );
    assert.equal(code, 1);
    assert.match(cap.errText(), /rolled back, nothing left behind/);
    assert.deepEqual(snapshotTree(root), before, "the rollback must leave the tree exactly as it started");
  });
});
