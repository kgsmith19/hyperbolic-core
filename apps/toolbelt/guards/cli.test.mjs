// node --test apps/toolbelt/guards/cli.test.mjs  (run from the repo root)
//
// cli.mjs owns the guard's own config mutations: enable/disable, secret
// globs, protected paths. Every test calls the exported main({argv, io})
// directly against a fresh GUARDS_CONFIG-sandboxed config file, so coverage
// tooling actually sees these lines execute (a subprocess call would not).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "./cli.mjs";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "guards-cli-test-"));
after(() => fs.rmSync(BASE, { recursive: true, force: true }));

let seq = 0;
function sandbox(config) {
  const configPath = path.join(BASE, `config-${seq++}.json`);
  if (config !== null) fs.writeFileSync(configPath, JSON.stringify(config ?? { enabled: true, secrets: [], protected: [] }));
  return configPath;
}

function io() {
  const out = [];
  const err = [];
  return {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

async function run(configPath, argv) {
  const prev = process.env.GUARDS_CONFIG;
  process.env.GUARDS_CONFIG = configPath;
  const i = io();
  try {
    const code = await main({ argv, io: i });
    return { code, out: i.text(), err: i.errText() };
  } finally {
    if (prev === undefined) delete process.env.GUARDS_CONFIG;
    else process.env.GUARDS_CONFIG = prev;
  }
}

test("status: reports enabled/secrets/protected only — no vault or runbox fields", async () => {
  const configPath = sandbox({ enabled: true, secrets: [".env"], protected: ["/x"] });
  const r = await run(configPath, ["status"]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { enabled: true, secrets: [".env"], protected: ["/x"] });
});

test("status: a missing config.json fails closed via CliFail, not a crash", async () => {
  const configPath = sandbox(null);
  const r = await run(configPath, ["status"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no config\.json at/);
});

test("toggle: on/off flips config.enabled and persists it", async () => {
  const configPath = sandbox({ enabled: false, secrets: [], protected: [] });
  let r = await run(configPath, ["toggle", "on"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /ENABLED/);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, true);

  r = await run(configPath, ["toggle", "off"]);
  assert.match(r.out, /DISABLED/);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).enabled, false);
});

test("toggle: any value other than on/off fails with usage", async () => {
  const configPath = sandbox({ enabled: true, secrets: [], protected: [] });
  const r = await run(configPath, ["toggle", "maybe"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: toggle on\|off/);
});

test("secret-add/rm: dedupes on add, no-ops on rm of an absent value", async () => {
  const configPath = sandbox({ enabled: true, secrets: [], protected: [] });
  let r = await run(configPath, ["secret-add", ".env"]);
  assert.match(r.out, /secrets: \.env/);
  r = await run(configPath, ["secret-add", ".env"]); // duplicate
  assert.match(r.out, /secrets: \.env\n$/);
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).secrets.length, 1);

  r = await run(configPath, ["secret-rm", ".env"]);
  assert.match(r.out, /secrets: \(empty\)/);
  r = await run(configPath, ["secret-rm", "never-there"]); // no-op, not an error
  assert.equal(r.code, 0);
});

test("secret-add: a missing value argument fails", async () => {
  const configPath = sandbox({ enabled: true, secrets: [], protected: [] });
  const r = await run(configPath, ["secret-add"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /value required/);
});

test("protected-add/rm: same shape as secrets, separate list", async () => {
  const configPath = sandbox({ enabled: true, secrets: [], protected: [] });
  let r = await run(configPath, ["protected-add", "/guards"]);
  assert.match(r.out, /protected: \/guards/);
  r = await run(configPath, ["protected-rm", "/guards"]);
  assert.match(r.out, /protected: \(empty\)/);
});

test("an unknown command fails with usage", async () => {
  const configPath = sandbox({ enabled: true, secrets: [], protected: [] });
  const r = await run(configPath, ["bogus"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage: cli\.mjs/);
});
