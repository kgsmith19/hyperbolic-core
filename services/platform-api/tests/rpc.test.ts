import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { render } from "../src/rpc.ts";
import { startPlatform } from "./support.ts";

let p: Awaited<ReturnType<typeof startPlatform>>;
before(async () => (p = await startPlatform()));
after(() => p.close());

const rpc = (profile: string, name: string, token: string | undefined, body: unknown = {}) => p.rest("POST", `/rpc/${name}`, profile, token, body);

test("is_platform_owner is true only for the owner", async () => {
  assert.equal((await rpc("core", "is_platform_owner", p.owner)).body, true);
  assert.equal((await rpc("core", "is_platform_owner", p.service)).body, false);
  assert.equal((await rpc("core", "is_platform_owner", undefined)).body, false);
});

test("log_run records a run and its cost for the owner or a service, never anyone else", async () => {
  await p.rest("POST", "/app", "core", p.owner, { id: "brain", name: "Brain", schema_name: "brain" });
  const args = { p_app_id: "brain", p_kind: "run", p_wall_clock_ms: 1200, p_input_tokens: 10, p_usd: 0.5 };
  const id = (await rpc("core", "log_run", p.service, args)).body;
  const run = await p.rest("GET", `/run?id=eq.${id}&select=status,user_id`, "core", p.owner);
  assert.deepEqual(run.body, [{ status: "ok", user_id: p.config.ownerId }]);
  const cost = await p.rest("GET", `/cost?run_id=eq.${id}&select=input_tokens,output_tokens,wall_clock_ms,usd`, "core", p.owner);
  assert.deepEqual(cost.body, [{ input_tokens: 10, output_tokens: 0, wall_clock_ms: 1200, usd: 0.5 }]);
  assert.equal((await rpc("core", "log_run", p.owner, args)).status, 200);
  assert.equal((await rpc("core", "log_run", p.anon, args)).status, 403);
  assert.equal((await rpc("core", "log_run", p.service, { ...args, p_wall_clock_ms: "slow" })).status, 400);
});

test("log_llm_call is owner-only; broker spend RPCs are service-only", async () => {
  const llm = { p_caller_app: "shell", p_purpose: "optimize", p_provider: "openai", p_model: "m", p_status: "ok" };
  assert.equal((await rpc("core", "log_llm_call", p.owner, llm)).status, 200);
  assert.equal((await rpc("core", "log_llm_call", p.service, llm)).status, 403);
  assert.equal((await rpc("core", "log_broker_call", p.owner, { p_caller: "brain", p_target_host: "api.x", p_cost_usd: 1 })).status, 403);
  await rpc("core", "log_broker_call", p.service, { p_caller: "brain", p_target_host: "api.x", p_cost_usd: 1.25 });
  await rpc("core", "log_broker_call", p.service, { p_caller: "brain", p_target_host: "api.x", p_cost_usd: 0.5 });
  assert.equal((await rpc("core", "broker_call_spend_today", p.service, { p_caller: "brain" })).body, 1.75);
  assert.equal((await rpc("core", "broker_call_spend_today", p.service, { p_caller: "other" })).body, 0);
});

test("render applies sections, then variables, then refuses missing variables, exactly as render_prompt did", () => {
  const body = "A<!--OPTIONAL:x-->[{{X}}]<!--/OPTIONAL:x--> B<!--OPTIONAL:y-->\n[y]\n<!--/OPTIONAL:y--> {{NAME}}";
  assert.equal(render(body, { NAME: "n" }, ["y"]), "A B\n[y]\n n", "excluded section's variable is never required");
  assert.equal(render(body, { NAME: "n", X: "x" }, ["x"]), "A[x] B n");
  assert.throws(() => render(body, {}, []), /missing variables: NAME/);
  assert.throws(() => render("{{B}} {{A}} {{B}}", {}, []), /missing variables: A, B/);
});

test("get_prompt resolves latest or pinned versions, merges config, and refuses what the original refused", async () => {
  const [prompt] = (await p.rest("POST", "/prompt", "prompt", p.owner, { title: "Summarize", body: "v1 {{TOPIC}}" })).body;
  await p.rest("PATCH", `/prompt?id=eq.${prompt.id}`, "prompt", p.owner, { body: "v2 {{TOPIC}}<!--OPTIONAL:tone--> ({{TONE}})<!--/OPTIONAL:tone-->" });
  await p.rest("POST", "/configuration", "prompt", p.owner, { prompt_id: prompt.id, name: "formal", values: { TONE: "formal", TOPIC: "saved" }, sections: ["tone"] });

  const latest = await rpc("prompt", "get_prompt", p.owner, { p_name: "summarize", p_values: { TOPIC: "x" } });
  assert.equal(latest.body.text, "v2 x");
  assert.equal(latest.body.version_no, 2);
  const pinned = await rpc("prompt", "get_prompt", p.owner, { p_name: "Summarize", p_version: 1, p_values: { TOPIC: "x" } });
  assert.equal(pinned.body.text, "v1 x");
  const configured = await rpc("prompt", "get_prompt", p.owner, { p_name: "Summarize", p_config: "formal", p_values: { TOPIC: "ad-hoc" } });
  assert.equal(configured.body.text, "v2 ad-hoc (formal)", "ad-hoc values win over saved config");

  assert.equal((await rpc("prompt", "get_prompt", p.owner, { p_name: "Summarize" })).body.code, "PT422");
  assert.equal((await rpc("prompt", "get_prompt", p.owner, { p_name: "Summarize", p_values: { TOPIC: 1 } })).body.code, "PT422");
  assert.equal((await rpc("prompt", "get_prompt", p.owner, { p_name: "nope" })).body.code, "PT404");
  assert.equal((await rpc("prompt", "get_prompt", p.owner, { p_name: "Summarize", p_version: 9 })).body.code, "PT404");
  assert.equal((await rpc("prompt", "get_prompt", p.owner, { p_name: "Summarize", p_config: "casual", p_values: { TOPIC: "x" } })).body.code, "PT404");
  assert.equal((await rpc("prompt", "get_prompt", p.service, { p_name: "Summarize" })).status, 403);

  const agent = p.auth.token("prompt_get_agent", "agent", 60, { scope: "prompt:get" });
  assert.equal((await rpc("prompt", "get_prompt", agent, { p_name: "Summarize", p_values: { TOPIC: "a" } })).body.text, "v2 a");
  const unscoped = p.auth.token("prompt_get_agent", "agent", 60, { scope: "prompt:list" });
  assert.equal((await rpc("prompt", "get_prompt", unscoped, { p_name: "Summarize" })).status, 403);

  await p.rest("PATCH", `/prompt?id=eq.${prompt.id}`, "prompt", p.owner, { is_active: false });
  assert.equal((await rpc("prompt", "get_prompt", p.owner, { p_name: "Summarize", p_values: { TOPIC: "x" } })).body.code, "PT404", "archived: no latest");
  assert.equal((await rpc("prompt", "get_prompt", p.owner, { p_name: "Summarize", p_version: 1, p_values: { TOPIC: "x" } })).body.text, "v1 x", "a pin survives archiving");
});

test("get_prompt_source returns the body, or not_modified for a matching p_if_version", async () => {
  await p.rest("POST", "/prompt", "prompt", p.owner, { title: "Source", body: "raw {{X}}" });
  assert.deepEqual((await rpc("prompt", "get_prompt_source", p.owner, { p_name: "source" })).body, { body: "raw {{X}}", version_no: 1, not_modified: false });
  assert.deepEqual((await rpc("prompt", "get_prompt_source", p.owner, { p_name: "source", p_if_version: 1 })).body, { body: null, version_no: 1, not_modified: true });
});

test("mark_submitted_to_github is service-only and only from 'idea'", async () => {
  const [idea] = (await p.rest("POST", "/idea", "intake", p.owner, { title: "Ship it", target_repo: "kgsmith19/hyperbolic-core" })).body;
  const args = { p_idea_id: idea.id, p_issue_number: 42, p_issue_url: "https://github.com/kgsmith19/hyperbolic-core/issues/42" };
  assert.equal((await rpc("intake", "mark_submitted_to_github", p.owner, args)).status, 403);
  assert.equal((await rpc("intake", "mark_submitted_to_github", p.service, args)).status, 400, "a draft cannot jump to submitted");
  await p.rest("PATCH", `/idea?id=eq.${idea.id}`, "intake", p.owner, { status: "idea" });
  const submitted = await rpc("intake", "mark_submitted_to_github", p.service, args);
  assert.equal(submitted.body.status, "submitted_to_github");
  assert.equal(submitted.body.github_issue_number, 42);
  assert.equal((await p.rest("DELETE", `/idea?id=eq.${idea.id}`, "intake", p.owner)).status, 400, "submitted ideas cannot be deleted");
  assert.equal((await rpc("intake", "mark_submitted_to_github", p.service, { ...args, p_idea_id: "00000000-0000-4000-8000-000000000000" })).status, 400);
  assert.equal((await rpc("core", "no_such_fn", p.owner)).status, 404);
});
