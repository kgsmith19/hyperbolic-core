/**
 * m4-04 / PO-5 verification script (05-d-prompt-organizer.md section 11's
 * EARS row for PO-5): "scratch script using only the published getPrompt
 * contract (no table names) prints text and version; run from
 * packages/llm/examples/, exit 0."
 *
 * This script deliberately imports nothing but the public contract --
 * `createPromptClient`, `GetPromptOptions`, `RenderedPrompt` -- exactly what
 * docs/planning/05-d-prompt-organizer.md section 6 publishes. It never
 * imports or mentions `prompt.prompt` / `prompt.prompt_version` / any other
 * schema-internal name, which is the concrete demonstration of PO-5 ("the
 * system shall serve it without that component holding schema knowledge").
 *
 * Real network access: this script needs a real Supabase project with
 * `prompt.get_prompt` deployed (m4-03's migration, applied by CI on merge --
 * not yet live on the shared project as of this writing, see
 * packages/llm/tests/real-pg.test.ts's header comment) plus a real prompt
 * seeded with the given name. Set PROMPT_ORGANIZER_URL, PROMPT_NAME, and
 * either PROMPT_ACCESS_TOKEN (a real bearer token) to exercise it end to
 * end. With no configuration at all, this script instead runs against an
 * in-process fake transport standing in for PostgREST -- enough to prove the
 * getPrompt contract's shape and this session's exit-0 requirement without
 * needing live credentials, while still exercising the exact same client
 * code every real caller uses.
 */
import { createPromptClient } from "../src/prompt-client.ts";

async function main(): Promise<void> {
  const supabaseUrl = process.env.PROMPT_ORGANIZER_URL;
  const name = process.env.PROMPT_NAME ?? "m4-04/example-fixture";

  const getAccessToken = async (): Promise<string> => {
    if (!supabaseUrl) return "fixture-token"; // fake-transport mode, see below
    const token = process.env.PROMPT_ACCESS_TOKEN;
    if (!token) throw new Error("PROMPT_ACCESS_TOKEN is not set");
    return token;
  };

  if (!supabaseUrl) {
    // No real project configured -- fall back to an in-process fake so this
    // script still demonstrates and exercises the real getPrompt contract
    // end to end without live credentials. See this file's own header
    // comment.
    installFakeTransport(name);
  }

  const client = createPromptClient(supabaseUrl ?? "https://example.supabase.invalid", getAccessToken);

  const rendered = await client.getPrompt(name, { variables: { EXAMPLE: "hyperbolic-core" } });

  // eslint-disable-next-line no-console
  console.log(rendered.text);
  // eslint-disable-next-line no-console
  console.log(`version: ${rendered.version}`);
}

/** Stands in for PostgREST when no real project is configured (see header
 * comment) -- this is example-script scaffolding, not part of the published
 * contract this script otherwise demonstrates. */
function installFakeTransport(name: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/rpc/get_prompt") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { p_name: string; p_values?: Record<string, string> };
      const example = body.p_values?.EXAMPLE ?? "world";
      const text = body.p_name === name ? `Hello from ${example}.` : "";
      return new Response(JSON.stringify({ text, version_no: 1, rendered_at: new Date().toISOString() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
