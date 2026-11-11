// One-level PostgREST embedding (#562): the exact selects the Shell's Prompts
// and Ideas zones send (apps/shell/frontend/src/lib/prompts.ts, intake.ts).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startPlatform } from "./support.ts";

let p: Awaited<ReturnType<typeof startPlatform>>;
before(async () => {
  p = await startPlatform();
});
after(() => p.close());

const PROMPT_SELECT = "id,title,body,is_active,created_at,tag(tag),prompt_version(version_no),configuration(name,values,sections)";

test("prompts embed tags, the newest version only, and configurations", async () => {
  const [prompt] = (await p.rest("POST", "/prompt", "prompt", p.owner, { title: "T", body: "B", is_active: true })).body;
  for (const tag of ["a", "b"]) assert.equal((await p.rest("POST", "/tag", "prompt", p.owner, { prompt_id: prompt.id, tag })).status, 201);
  // Versions come from the schema's own trigger: one per body (v1 on insert).
  for (const body of ["B2", "B3"]) {
    assert.equal((await p.rest("PATCH", `/prompt?id=eq.${prompt.id}`, "prompt", p.owner, { body })).status, 200);
  }
  const cfg = await p.rest("POST", "/configuration", "prompt", p.owner, { prompt_id: prompt.id, name: "default", values: { x: 1 }, sections: [], created_at: new Date().toISOString() });
  assert.equal(cfg.status, 201, JSON.stringify(cfg.body));
  const res = await p.rest(
    "GET",
    `/prompt?select=${PROMPT_SELECT}&order=created_at.desc&prompt_version.order=version_no.desc&prompt_version.limit=1`,
    "prompt",
    p.owner,
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = res.body.find((r: { id: string }) => r.id === prompt.id);
  assert.deepEqual(row.tag.map((t: { tag: string }) => t.tag).sort(), ["a", "b"]);
  assert.deepEqual(row.prompt_version, [{ version_no: 3 }]);
  assert.deepEqual(row.configuration, [{ name: "default", values: { x: 1 }, sections: [] }]);
  assert.equal(row.is_active, true);
});

test("ideas embed their parent (to-one via the foreign-key column), null when there is none", async () => {
  const [parent] = (await p.rest("POST", "/idea", "intake", p.owner, { title: "Parent", problem: "p", target_repo: "o/r" })).body;
  // Only a submitted idea can have derivatives (II-3); submission is the
  // service's job, so the fixture walks the lifecycle directly.
  p.db.prepare("update intake_idea set status = 'idea' where id = ?").run(parent.id);
  p.db.prepare(
    "update intake_idea set status = 'submitted_to_github', github_issue_number = 7, github_issue_url = 'https://github.com/o/r/issues/7', submitted_at = '2026-11-11T00:00:00Z' where id = ?",
  ).run(parent.id);
  const created = await p.rest("POST", "/idea", "intake", p.owner, { title: "Child", problem: "c", parent_idea_id: parent.id, target_repo: "o/r" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const [child] = created.body;
  const res = await p.rest("GET", "/idea?select=id,title,parent:parent_idea_id(github_issue_url,title)&order=created_at.desc", "intake", p.owner);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byId = Object.fromEntries(res.body.map((r: { id: string }) => [r.id, r]));
  assert.deepEqual(byId[child.id].parent, { github_issue_url: "https://github.com/o/r/issues/7", title: "Parent" });
  assert.equal(byId[parent.id].parent, null);
});

test("embedding stays inside the declared relations and the caller's grants", async () => {
  const unknown = await p.rest("GET", "/prompt?select=id,usage(id)", "prompt", p.owner);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "PGRST200");
  const anon = await p.rest("GET", `/prompt?select=${PROMPT_SELECT}`, "prompt", undefined);
  assert.equal(anon.status, 401);
  const write = await p.rest("POST", "/prompt?select=id,tag(tag)", "prompt", p.owner, { title: "x", body: "y" });
  assert.equal(write.status, 400);
});
