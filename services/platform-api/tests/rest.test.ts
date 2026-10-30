import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startPlatform } from "./support.ts";

let p: Awaited<ReturnType<typeof startPlatform>>;
before(async () => (p = await startPlatform()));
after(() => p.close());

test("anonymous and anon-key callers are refused on every table", async () => {
  for (const token of [undefined, p.anon]) {
    const res = await p.rest("GET", "/app", "core", token);
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  }
});

test("the owner reads and writes core tables with filters, order, limit and representation", async () => {
  const created = await p.rest("POST", "/app", "core", p.owner, [
    { id: "a1", name: "Alpha", schema_name: "alpha", status: "live", manifest: { kind: "ui" } },
    { id: "b2", name: "Beta", schema_name: "beta" },
  ]);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.map((r: any) => r.id), ["a1", "b2"]);
  assert.deepEqual(created.body[0].manifest, { kind: "ui" }, "json columns round-trip as JSON");

  const live = await p.rest("GET", "/app?status=eq.live&select=id,name", "core", p.owner);
  assert.deepEqual(live.body, [{ id: "a1", name: "Alpha" }]);
  const ordered = await p.rest("GET", "/app?select=id&order=id.desc&limit=1", "core", p.owner);
  assert.deepEqual(ordered.body, [{ id: "b2" }]);
  const inList = await p.rest("GET", "/app?id=in.(a1,zz)&select=id", "core", p.owner);
  assert.deepEqual(inList.body, [{ id: "a1" }]);
  const nullRoute = await p.rest("GET", "/app?route=is.null&select=id&order=id.asc", "core", p.owner);
  assert.equal(nullRoute.body.length, 2);

  const patched = await p.rest("PATCH", "/app?id=eq.b2", "core", p.owner, { status: "building" });
  assert.deepEqual(patched.body.map((r: any) => r.status), ["building"]);
  assert.equal((await p.rest("DELETE", "/app?id=eq.b2", "core", p.owner, undefined, "return=minimal")).status, 204);
  assert.equal((await p.rest("GET", "/app?id=eq.b2", "core", p.owner)).body.length, 0);
});

test("unsupported query features are a 400, never a different query", async () => {
  for (const route of ["/app?select=id,run(*)", "/app?id=cs.{a}", "/app?nope=eq.1", "/app?id=eq1", "/app?limit=-1", "/app?order=id.sideways"]) {
    assert.equal((await p.rest("GET", route, "core", p.owner)).status, 400, route);
  }
  assert.equal((await p.rest("PATCH", "/app", "core", p.owner, { name: "x" })).status, 400, "an unfiltered update is refused");
  assert.equal((await p.rest("DELETE", "/app", "core", p.owner)).status, 400, "an unfiltered delete is refused");
  assert.equal((await p.rest("GET", "/app", "nosuch", p.owner)).status, 404);
});

test("prompt tables keep their grants: user_id is the owner, versions are append-only, service cannot touch them", async () => {
  const [prompt] = (await p.rest("POST", "/prompt", "prompt", p.owner, { title: "Greet", body: "Hello {{NAME}}" })).body;
  assert.equal(prompt.user_id, p.config.ownerId, "user_id defaults to the owner");
  assert.equal(prompt.is_active, true);
  const forged = await p.rest("POST", "/prompt", "prompt", p.owner, { title: "X", body: "y", user_id: "00000000-0000-4000-8000-000000000000" });
  assert.equal(forged.status, 403);

  await p.rest("PATCH", `/prompt?id=eq.${prompt.id}`, "prompt", p.owner, { body: "Hi {{NAME}}" });
  const versions = await p.rest("GET", `/prompt_version?prompt_id=eq.${prompt.id}&select=version_no,body&order=version_no.asc`, "prompt", p.owner);
  assert.deepEqual(versions.body, [{ version_no: 1, body: "Hello {{NAME}}" }, { version_no: 2, body: "Hi {{NAME}}" }]);
  await p.rest("PATCH", `/prompt?id=eq.${prompt.id}`, "prompt", p.owner, { title: "Greeting" });
  assert.equal((await p.rest("GET", `/prompt_version?prompt_id=eq.${prompt.id}`, "prompt", p.owner)).body.length, 2, "a title edit is not a version");

  assert.equal((await p.rest("PATCH", `/prompt?id=eq.${prompt.id}`, "prompt", p.owner, { user_id: p.config.ownerId })).status, 403, "user_id is not updatable");
  assert.equal((await p.rest("PATCH", `/prompt_version?prompt_id=eq.${prompt.id}`, "prompt", p.owner, { body: "rewrite" })).status, 403);
  assert.equal((await p.rest("DELETE", `/prompt?id=eq.${prompt.id}`, "prompt", p.owner)).status, 403);
  assert.equal((await p.rest("GET", "/prompt", "prompt", p.service)).status, 403);

  const dup = await p.rest("POST", "/prompt", "prompt", p.owner, { title: "greeting", body: "z" });
  assert.equal(dup.status, 409, "titles are unique case-insensitively");
  assert.equal(dup.body.code, "23505");
});

test("intake ideas keep their lifecycle guards through the REST surface", async () => {
  const [idea] = (await p.rest("POST", "/idea", "intake", p.owner, { title: "Local first" })).body;
  assert.equal(idea.status, "draft");
  assert.equal((await p.rest("POST", "/idea", "intake", p.owner, { title: "x", status: "idea" })).status, 403, "status is not an insert column");
  const noRepo = await p.rest("PATCH", `/idea?id=eq.${idea.id}`, "intake", p.owner, { status: "idea" });
  assert.equal(noRepo.status, 400, "beyond draft needs a target repo");
  const promoted = await p.rest("PATCH", `/idea?id=eq.${idea.id}`, "intake", p.owner, { status: "idea", target_repo: "kgsmith19/hyperbolic-core" });
  assert.equal(promoted.status, 200);
  assert.ok(promoted.body[0].updated_at > idea.updated_at || promoted.body[0].updated_at >= idea.updated_at);
  assert.equal((await p.rest("PATCH", `/idea?id=eq.${idea.id}`, "intake", p.owner, { status: "draft" })).status, 400, "no going back to draft");
  assert.equal((await p.rest("PATCH", `/idea?id=eq.${idea.id}`, "intake", p.owner, { github_issue_number: 5 })).status, 403);
  assert.equal((await p.rest("POST", "/idea", "intake", p.owner, { title: "fork", parent_idea_id: idea.id })).status, 400, "only submitted ideas fork");
});

test("score bounds from metric_def are enforced", async () => {
  await p.rest("POST", "/app", "core", p.owner, { id: "toolbelt", name: "Toolbelt", schema_name: "toolbelt" });
  await p.rest("POST", "/metric_def", "core", p.owner, { id: "m1", name: "M", formula: "f", unit: "u", gaming_risk: "low", min_value: 0, max_value: 10 });
  await p.rest("POST", "/idea", "idea", p.owner, { id: "i1", name: "I", category: "c", one_liner: "o" });
  assert.equal((await p.rest("POST", "/score", "idea", p.owner, { idea_id: "i1", metric_id: "m1", value: 11, scored_by: "t" })).status, 400);
  assert.equal((await p.rest("POST", "/score", "idea", p.owner, { idea_id: "i1", metric_id: "m1", value: 5, scored_by: "t" })).status, 201);
});
