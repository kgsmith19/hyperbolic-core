import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("runtime manifest validation dependencies are declared by the CLI package", () => {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  assert.match(pkg.dependencies?.ajv ?? "", /^\^8\./);
  assert.match(pkg.dependencies?.["ajv-formats"] ?? "", /^\^3\./);
});
