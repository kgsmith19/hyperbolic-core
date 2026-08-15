// m3-07 e2e harness, part 2: runs the REAL services/llm-handler orchestration
// code (src/server.ts's createHandler, unmodified) as a real local
// node:http server, wired at its two real dependency boundaries:
//
//   1. Postgres/PostgREST -- points HandlerConfig.supabaseUrl at
//      ./intake-fixture.ts's real Postgres-backed shim, so
//      src/postgrest.ts's fetchIdeaForSubmit/writeBackSubmitted and
//      src/auth.ts's verifyOwnerSession all run their real request logic
//      against real data.
//   2. GitHub -- the one genuinely external third party. src/github-client.ts
//      hardcodes `https://api.github.com` (not configurable), so this file
//      monkeypatches `globalThis.fetch` IN THIS NODE PROCESS ONLY (Handler A
//      runs in-process, not as a spawned child) to answer exactly those two
//      calls (create issue, list-for-marker-scan) while every other fetch
//      (to the intake-fixture shim) passes through untouched to the real
//      implementation. This is the same "mock only the true external
//      dependency" boundary services/llm-handler's own unit tests already
//      draw (tests/github-client.test.ts).
import { createServer, type Server } from "node:http";
import { createHandler } from "../../../../../services/llm-handler/src/server.ts";
import type { HandlerConfig } from "../../../../../services/llm-handler/src/types.ts";

export interface FixtureCreatedIssue {
  number: number;
  htmlUrl: string;
  ownerRepo: string;
  title: string;
  body: string;
  labels: string[];
}

export interface HandlerAFixture {
  baseUrl: string;
  createdIssues: FixtureCreatedIssue[];
  teardown(): void;
}

const REPO_ISSUES_RE = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues(\?.*)?$/;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function setupHandlerAFixture(opts: {
  supabaseUrl: string;
  serviceRoleKey: string;
  supabasePublishableKey?: string;
}): Promise<HandlerAFixture> {
  const createdIssues: FixtureCreatedIssue[] = [];
  let nextIssueNumber = 5001;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const match = REPO_ISSUES_RE.exec(url);
    if (!match) {
      return realFetch(input, init);
    }
    const ownerRepo = match[1]!;
    if ((init?.method ?? "GET") === "GET") {
      // findIssueByMarker's existence scan: no pre-existing from-idea-intake
      // issues in this fixture, so every submit in this spec takes the
      // create-new-issue path (the short-page branch: length < per_page
      // stops the scan at page 1).
      return jsonResponse(200, []);
    }
    if ((init?.method ?? "GET") === "POST") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as { title: string; body: string; labels: string[] };
      const number = nextIssueNumber++;
      const htmlUrl = `https://github.com/${ownerRepo}/issues/${number}`;
      createdIssues.push({ number, htmlUrl, ownerRepo, title: payload.title, body: payload.body, labels: payload.labels });
      return jsonResponse(201, { number, html_url: htmlUrl });
    }
    return jsonResponse(404, { message: "handler-a-fixture: unsupported GitHub call" });
  }) as typeof fetch;

  const config: HandlerConfig = {
    port: 0,
    supabaseUrl: opts.supabaseUrl,
    supabasePublishableKey: opts.supabasePublishableKey ?? "fixture-publishable-key",
    githubIntakePat: "fixture-github-intake-pat",
  };

  const server: Server = createServer(createHandler(config, opts.serviceRoleKey));
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("handler-a-fixture: server did not report a port"));
        return;
      }
      resolve(address.port);
    });
  });

  function teardown(): void {
    globalThis.fetch = realFetch;
    server.close();
  }

  return { baseUrl: `http://127.0.0.1:${port}`, createdIssues, teardown };
}
