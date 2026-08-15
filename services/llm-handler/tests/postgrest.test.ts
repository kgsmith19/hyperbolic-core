import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchIdeaForSubmit, writeBackSubmitted, isValidUuid } from "../src/postgrest.ts";

type FetchImpl = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

async function withPatchedFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const VALID_ID = "11111111-1111-1111-1111-111111111111";

test("isValidUuid: accepts a real UUID, rejects everything else", () => {
  assert.equal(isValidUuid(VALID_ID), true);
  assert.equal(isValidUuid("not-a-uuid"), false);
  assert.equal(isValidUuid(""), false);
  assert.equal(isValidUuid(123), false);
  assert.equal(isValidUuid(null), false);
  assert.equal(isValidUuid(`${VALID_ID}&extra=param`), false, "must not accept a value with query-injection-shaped trailing content");
});

test("fetchIdeaForSubmit: an invalid ideaId resolves null without any network call", async () => {
  let called = false;
  await withPatchedFetch(
    async () => {
      called = true;
      return new Response("[]", { status: 200 });
    },
    async () => {
      const result = await fetchIdeaForSubmit("https://proj.supabase.co", "anon", "token", "not-a-uuid");
      assert.equal(result, null);
    }
  );
  assert.equal(called, false, "an invalid uuid must never reach the network");
});

test("fetchIdeaForSubmit: builds the exact request shape (Accept-Profile: intake, embedded parent select)", async () => {
  await withPatchedFetch(
    async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://proj.supabase.co");
      assert.equal(url.pathname, "/rest/v1/idea");
      assert.equal(url.searchParams.get("id"), `eq.${VALID_ID}`);
      assert.match(url.searchParams.get("select") ?? "", /parent:parent_idea_id\(github_issue_url\)/);
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.apikey, "anon-key");
      assert.equal(headers.Authorization, "Bearer caller-jwt");
      assert.equal(headers["Accept-Profile"], "intake");
      return new Response(
        JSON.stringify([
          {
            status: "idea",
            title: "T",
            problem: "P",
            outcome: "O",
            notes: "N",
            confidence: "high",
            source: "S",
            target_repo: "o/r",
            idempotency_key: "22222222-2222-2222-2222-222222222222",
            github_issue_number: null,
            github_issue_url: null,
            parent: { github_issue_url: "https://github.com/o/r/issues/1" },
          },
        ]),
        { status: 200 }
      );
    },
    async () => {
      const idea = await fetchIdeaForSubmit("https://proj.supabase.co", "anon-key", "caller-jwt", VALID_ID);
      assert.ok(idea);
      assert.equal(idea?.status, "idea");
      assert.equal(idea?.parentGithubIssueUrl, "https://github.com/o/r/issues/1");
      assert.equal(idea?.targetRepo, "o/r");
    }
  );
});

test("fetchIdeaForSubmit: no parent set maps to parentGithubIssueUrl null", async () => {
  await withPatchedFetch(
    async () =>
      new Response(
        JSON.stringify([
          {
            status: "draft",
            title: "T",
            problem: "",
            outcome: "",
            notes: "",
            confidence: "medium",
            source: "",
            target_repo: null,
            idempotency_key: "22222222-2222-2222-2222-222222222222",
            github_issue_number: null,
            github_issue_url: null,
            parent: null,
          },
        ]),
        { status: 200 }
      ),
    async () => {
      const idea = await fetchIdeaForSubmit("https://proj.supabase.co", "anon", "token", VALID_ID);
      assert.equal(idea?.parentGithubIssueUrl, null);
    }
  );
});

test("fetchIdeaForSubmit: an empty result set (RLS-hidden or nonexistent row) resolves null", async () => {
  await withPatchedFetch(
    async () => new Response("[]", { status: 200 }),
    async () => {
      const result = await fetchIdeaForSubmit("https://proj.supabase.co", "anon", "token", VALID_ID);
      assert.equal(result, null);
    }
  );
});

test("fetchIdeaForSubmit: a non-2xx response resolves null, never throws", async () => {
  await withPatchedFetch(
    async () => new Response("error", { status: 500 }),
    async () => {
      const result = await fetchIdeaForSubmit("https://proj.supabase.co", "anon", "token", VALID_ID);
      assert.equal(result, null);
    }
  );
});

test("writeBackSubmitted: an invalid ideaId resolves false without any network call", async () => {
  let called = false;
  await withPatchedFetch(
    async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
    async () => {
      const result = await writeBackSubmitted("https://proj.supabase.co", "service-role-key", "not-a-uuid", {
        number: 1,
        htmlUrl: "https://github.com/o/r/issues/1",
      });
      assert.equal(result, false);
    }
  );
  assert.equal(called, false);
});

test("writeBackSubmitted: calls the mark_submitted_to_github RPC with the service-role key, not any caller token", async () => {
  await withPatchedFetch(
    async (input, init) => {
      assert.equal(String(input), "https://proj.supabase.co/rest/v1/rpc/mark_submitted_to_github");
      assert.equal(init?.method, "POST");
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.apikey, "service-role-key");
      assert.equal(headers.Authorization, "Bearer service-role-key");
      assert.equal(headers["Content-Profile"], "intake");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        p_idea_id: VALID_ID,
        p_issue_number: 7,
        p_issue_url: "https://github.com/o/r/issues/7",
      });
      return new Response(JSON.stringify({ id: VALID_ID, status: "submitted_to_github" }), { status: 200 });
    },
    async () => {
      const result = await writeBackSubmitted("https://proj.supabase.co", "service-role-key", VALID_ID, {
        number: 7,
        htmlUrl: "https://github.com/o/r/issues/7",
      });
      assert.equal(result, true);
    }
  );
});

test("writeBackSubmitted: a non-ok RPC response (e.g. the guard trigger raising) resolves false, never throws", async () => {
  await withPatchedFetch(
    async () => new Response(JSON.stringify({ message: "II-1: illegal transition draft -> submitted_to_github" }), { status: 400 }),
    async () => {
      const result = await writeBackSubmitted("https://proj.supabase.co", "service-role-key", VALID_ID, {
        number: 1,
        htmlUrl: "https://github.com/o/r/issues/1",
      });
      assert.equal(result, false);
    }
  );
});
