import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule, readStdinJson, resolveRoot } from "./root.mjs";

test("resolveRoot uses the explicit ACC root and the module fallback", () => {
  const before = process.env.ACC_ROOT;
  process.env.ACC_ROOT = "./explicit-root";
  assert.equal(resolveRoot("/tmp/module/hooks"), path.resolve("./explicit-root"));
  delete process.env.ACC_ROOT;
  assert.equal(resolveRoot("/tmp/module/hooks"), path.resolve("/tmp/module"));
  if (before === undefined) delete process.env.ACC_ROOT;
  else process.env.ACC_ROOT = before;
});

test("readStdinJson returns parsed input, an empty object, or its caller fallback", () => {
  const original = fs.readFileSync;
  try {
    fs.readFileSync = () => '{"ok":true}';
    assert.deepEqual(readStdinJson(), { ok: true });
    fs.readFileSync = () => "";
    assert.deepEqual(readStdinJson(), {});
    fs.readFileSync = () => { throw new Error("unreadable"); };
    assert.equal(readStdinJson(null), null);
  } finally {
    fs.readFileSync = original;
  }
});

test("isMainModule distinguishes the current entry point from other modules", () => {
  assert.equal(isMainModule(pathToFileURL(process.argv[1]).href), true);
  assert.equal(isMainModule(pathToFileURL(path.join(process.cwd(), "not-main.mjs")).href), false);
});
