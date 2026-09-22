// node --test inventories/secrets/inventory.test.mjs (run from the repo root)
//
// INT-09 (#397): the runtime secret-consumer inventory is metadata-only and
// schema-valid; every live change needs a metadata-only proof shape; raw
// secret material is rejected everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = fs.readFileSync(path.join(HERE, "INVENTORY.md"), "utf-8");
const EXCEPTIONS = fs.readFileSync(path.join(HERE, "EXCEPTIONS.md"), "utf-8");

const SECRET_SHAPES = [
  /sk-(ant-)?[A-Za-z0-9]{8,}/,
  /xox[bap]-/,
  /ghp_[A-Za-z0-9]{8,}/,
  /AKIA[0-9A-Z]{16}/,
];

function rows(md) {
  return md.split("\n").filter((l) => l.startsWith("| `"));
}

test("inventory rows carry the five metadata fields and no values", () => {
  const dataRows = rows(INVENTORY);
  assert.ok(dataRows.length >= 10, `want >=10 consumer rows, got ${dataRows.length}`);
  for (const row of dataRows) {
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    assert.equal(cells.length, 5, `row needs 5 metadata cells: ${row}`);
  }
});

test("inventory and exceptions carry no secret-shaped material", () => {
  for (const [name, text] of [["INVENTORY.md", INVENTORY], ["EXCEPTIONS.md", EXCEPTIONS]]) {
    for (const shape of SECRET_SHAPES) {
      assert.ok(!shape.test(text), `${name} carries secret-shaped material`);
    }
  }
});

test("public configuration excluded from the vault", () => {
  assert.ok(INVENTORY.includes("Public configuration (excluded from the vault"),
    "public-config exclusion section present");
  assert.ok(INVENTORY.includes("vars.INFISICAL_"), "identity selectors listed as public");
});

test("exception list justifies every entry", () => {
  const dataRows = rows(EXCEPTIONS);
  assert.ok(dataRows.length >= 1, "at least one approved exception");
  for (const row of dataRows) {
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    assert.ok(cells.length >= 3 && cells[1].length > 0, `justification required: ${row}`);
  }
});

test("proof shape is metadata-only", () => {
  const runbook = fs.readFileSync(
    path.join(HERE, "..", "..", "runbooks", "secrets-rotation-outage-restore.md"), "utf-8");
  assert.ok(runbook.includes("{handle, scope, change:"), "proof format declared");
  assert.ok(!/value|secret-material/i.test(
    runbook.split("## Proof format")[1].split("\n").find((l) => l.startsWith("`{")) || ""),
    "proof carries handles, never values");
});
