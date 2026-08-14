import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.ACC_ROUTING_MD ||= path.join(here, "fixtures", "ROUTING.md");
const { DEFAULT_TABLE, doctor, route, scanRoots } = await import("./route.mjs");

// Every other test in this file sets ACC_ROUTING_MD, so nothing here ever
// exercised the built-in default -- which is exactly how it came to point at
// <checkout>/apps/ROUTING.md (a path that never exists) when ACC was imported
// into the monorepo as a subtree, breaking /api/route/suggest in production
// while the suite stayed green. The table is machine-local and uncommitted,
// so its existence cannot be asserted; where the default resolves to can.
test("the built-in routing-table default resolves beside the checkout, never inside it", () => {
  const checkout = path.resolve(here, "..", "..", "..");
  assert.equal(DEFAULT_TABLE, path.join(path.dirname(checkout), "ROUTING.md"));
  assert.ok(!DEFAULT_TABLE.startsWith(checkout + path.sep), `default must not resolve inside the checkout: ${DEFAULT_TABLE}`);
});

test("backend and frontend tasks route to their LifeOS monorepo slices", () => {
  assert.equal(route("add a supabase migration and pytest").label, "lifeos-backend");
  assert.equal(route("fix the react tailwind component").label, "lifeos-frontend");
});

test("a cross-application LifeOS task routes to the product root", () => {
  const result = route("change the api contract and regenerate types.gen.ts");
  assert.equal(result.label, "lifeos");
  assert.equal(result.path, "C:\\code\\lifeos-ecosystem\\lifeos");
});

test("an exact backend/frontend tie routes to their common product root", () => {
  const result = route("add a fastapi supabase change plus the react tailwind component");
  assert.equal(result.path, "C:\\code\\lifeos-ecosystem\\lifeos");
});

test("a one-signal lead keeps the narrow application slice", () => {
  assert.equal(route("supabase migration and pytest, then touch one react component").label, "lifeos-backend");
});

test("ACC and unmatched work retain their explicit results", () => {
  assert.equal(route("the guards hook misfires").label, "acc");
  assert.equal(route("what did we decide yesterday").path, null);
});

test("every narrow verdict names the product root as its parent", () => {
  const productRoot = "C:\\code\\lifeos-ecosystem\\lifeos";
  assert.equal(route("supabase migration").parent, productRoot);
  assert.equal(route("fix the tailwind component").parent, productRoot);
  assert.equal(route("the guards hook misfires").parent, "C:\\code");
});

test("--text returns parseable service output without prompt instructions", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(here, "route.mjs"), "--text", "fix the playwright e2e run"],
    { encoding: "utf8", env: { ...process.env, ACC_ROUTING_MD: path.join(here, "fixtures", "ROUTING.md") } },
  );
  const result = JSON.parse(output);
  assert.equal(result.label, "lifeos-frontend");
  assert.equal(result.hookSpecificOutput, undefined);
});

test("--text fails safely when the route table is invalid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-route-bad-"));
  const table = path.join(dir, "ROUTING.md");
  fs.writeFileSync(table, "no JSON route table here\n");
  const output = execFileSync(
    process.execPath,
    [path.join(here, "route.mjs"), "--text", "anything"],
    { encoding: "utf8", env: { ...process.env, ACC_ROUTING_MD: table } },
  );
  assert.match(JSON.parse(output).error, /no json block/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--text names ACC_ROUTING_MD when the route table is missing entirely", () => {
  // A table that is unreadable rather than malformed is the case that broke
  // silently after the monorepo import: a bare ENOENT gives the caller
  // nothing to act on, so the message has to name the override.
  const missing = path.join(os.tmpdir(), "acc-route-absent", "ROUTING.md");
  const output = execFileSync(
    process.execPath,
    [path.join(here, "route.mjs"), "--text", "anything"],
    { encoding: "utf8", env: { ...process.env, ACC_ROUTING_MD: missing } },
  );
  const result = JSON.parse(output);
  assert.equal(result.path, null);
  assert.match(result.error, /cannot read routing table/);
  assert.match(result.error, /ACC_ROUTING_MD/);
  assert.match(result.error, /ENOENT/);
});

test("doctor requires an exact route for each repository", () => {
  const routes = [{ path: "C:\\code\\guards" }, { path: "C:\\code" }];
  assert.deepEqual(doctor(routes, ["C:\\code\\guards", "C:\\code\\newrepo"]), ["C:\\code\\newrepo"]);
  assert.deepEqual(doctor([{ path: "C:\\code\\Guards" }], ["c:\\CODE\\guards"]), []);
});

test("doctor scan roots use the Windows defaults or an explicit portable list", () => {
  assert.deepEqual(scanRoots(undefined), ["C:\\code", "C:\\code\\lifeos-ecosystem"]);
  assert.deepEqual(
    scanRoots(["/one", "", "/two"].join(path.delimiter)),
    ["/one", "/two"],
  );
});

test("edge-case route tables fail safely and keep deterministic fallbacks", () => {
  const widest = [{ label: "root", path: "/workspace", signals: ["root"] }];
  assert.equal(route("root", { routes: widest }).parent, null);

  const siblings = [
    { label: "one", path: "/one", signals: ["shared"] },
    { label: "two", path: "/two", signals: ["shared"] },
  ];
  const noCommonAncestor = route("shared", { routes: siblings });
  assert.equal(noCommonAncestor.label, "one");
  assert.match(noCommonAncestor.reason, /no common ancestor/);

  const invalidSignal = [
    { label: "invalid", path: "/invalid", signals: ["["] },
    { label: "safe", path: "/safe", signals: ["safe"] },
    { label: "missing-signals", path: "/missing" },
  ];
  assert.equal(route("safe", { routes: invalidSignal }).label, "safe");
  assert.equal(route("anything else", { routes: invalidSignal }).path, null);
});

test("doctor CLI reports both complete and incomplete repository inventories", () => {
  const run = ({ exact }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-route-doctor-"));
    const codeRoot = path.join(dir, "code");
    const repo = path.join(codeRoot, "sample");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Test repository\n");
    fs.writeFileSync(path.join(codeRoot, "README.txt"), "not a repository\n");
    fs.mkdirSync(path.join(codeRoot, "untracked-directory"));
    const table = path.join(dir, "ROUTING.md");
    const routes = [{
      label: exact ? "sample" : "wide",
      path: exact ? repo : codeRoot,
      signals: [exact ? "sample" : "wide"],
    }];
    fs.writeFileSync(table, `\`\`\`json\n${JSON.stringify({ routes })}\n\`\`\`\n`);
    const result = spawnSync(process.execPath, [path.join(here, "route.mjs"), "doctor"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        ACC_ROUTING_MD: table,
        ACC_ROUTE_SCAN_ROOTS: [codeRoot, path.join(dir, "missing-root")].join(path.delimiter),
      },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  };

  const complete = run({ exact: true });
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /routing clean/);

  const incomplete = run({ exact: false });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stdout, /UNROUTED repo dirs/);
  assert.match(incomplete.stdout, /sample/);
});
