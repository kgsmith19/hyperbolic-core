import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const canaryDir = path.join(root, "docs/ops/canary");

// G2 (#406): every production deploy unit declares a canary — exposure,
// baseline, observation window, 2–5 named invariants with halt thresholds,
// and success/halt criteria. This oracle pins the declaration SHAPE;
// observing the invariants from real telemetry is G3 (#407).
const EXPECTED_UNITS = ["shell", "llm-handler", "brain", "broker", "lifeos-backend", "lifeos-ui"];

function parseCanary(file) {
  // Minimal indentation-aware YAML subset parser for the canary shape:
  // top-level scalars, window_hours number, exposure number, and the
  // invariants list (name/signal/halt_if per item). Full YAML is not
  // needed — the shape is deliberately flat.
  // Normalize CRLF checkouts: committed bytes are LF; the Windows-local
  // lane checks out CRLF, which would otherwise poison exact matching.
  const text = readFileSync(path.join(canaryDir, file), "utf8").replace(/\r\n/g, "\n");
  const top = {};
  const invariants = [];
  let current = null;
  for (const raw of text.split("\n")) {
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const invItem = raw.match(/^  - name: (.+)$/);
    if (invItem) {
      current = { name: invItem[1].trim() };
      invariants.push(current);
      continue;
    }
    const invField = raw.match(/^    (signal|halt_if): (.+)$/);
    if (invField && current) {
      current[invField[1]] = invField[2].trim();
      continue;
    }
    const kv = raw.match(/^([a-z_]+): (.+)$/);
    if (kv) top[kv[1]] = kv[2].trim();
  }
  return { top, invariants };
}

test("every production unit has a canary declaration, named for its unit", () => {
  const files = readdirSync(canaryDir).filter((f) => f.endsWith(".canary.yml")).sort();
  assert.deepEqual(
    [...files].sort(),
    [...EXPECTED_UNITS.map((u) => `${u}.canary.yml`)].sort(),
    "a unit is missing its canary declaration (or a stray file was added)",
  );
  for (const file of files) {
    const { top } = parseCanary(file);
    assert.equal(top.unit, file.replace(".canary.yml", ""), `${file}: unit must match its file name`);
  }
});

test("every declaration carries exposure, baseline, window, success, and halt", () => {
  for (const unit of EXPECTED_UNITS) {
    const { top } = parseCanary(`${unit}.canary.yml`);
    const exposure = Number(top.exposure);
    assert.ok(exposure > 0 && exposure <= 1, `${unit}: exposure must be a (0,1] fraction, got ${top.exposure}`);
    assert.ok(top.baseline && top.baseline.length > 0, `${unit}: baseline required`);
    const windowHours = Number(top.window_hours);
    assert.ok(Number.isFinite(windowHours) && windowHours > 0, `${unit}: window_hours must be > 0`);
    assert.ok(top.success && top.success.length > 0, `${unit}: success criterion required`);
    assert.ok(top.halt && top.halt.length > 0, `${unit}: halt criterion required`);
  }
});

test("every declaration names 2–5 invariants, each with a signal and a halt threshold", () => {
  for (const unit of EXPECTED_UNITS) {
    const { invariants } = parseCanary(`${unit}.canary.yml`);
    assert.ok(
      invariants.length >= 2 && invariants.length <= 5,
      `${unit}: must name 2–5 invariants, got ${invariants.length}`,
    );
    for (const inv of invariants) {
      assert.match(inv.name, /^[a-z0-9][a-z0-9_-]*$/, `${unit}: invariant name must be a stable identifier`);
      assert.ok(inv.signal && inv.signal.length > 0, `${unit}/${inv.name}: signal required (G3 reads it)`);
      assert.ok(inv.halt_if && inv.halt_if.length > 0, `${unit}/${inv.name}: halt_if required — an invariant without a halt threshold is an observation, not a gate`);
    }
    const names = invariants.map((i) => i.name);
    assert.equal(new Set(names).size, names.length, `${unit}: invariant names must be unique`);
  }
});
