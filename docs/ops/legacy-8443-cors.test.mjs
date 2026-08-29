import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const main = readFileSync(path.join(root, "apps/lifeos/backend/src/api/main.py"), "utf8");

test("LifeOS no longer carries the standalone 8443 browser origin as a CORS default", () => {
  assert.doesNotMatch(main, /lifeos-prod\.taile48c9b\.ts\.net:8443/);
  assert.match(main, /_UI_ORIGINS = "http:\/\/localhost:5173"/);
  assert.match(main, /Production\r?\n# LifeOS is same-origin with Shell under \/life\//);
});
