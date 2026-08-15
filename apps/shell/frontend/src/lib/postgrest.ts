// The one PostgREST call path for every Shell data client.
//
// cost.ts, intake.ts, optimize.ts and prompts.ts each carried a private
// `getAccessToken` (byte-identical but for the error prefix) and three of them
// a private `postgrest`. The three differed only in which schema profile they
// pinned and whether they handled a request body — prompts.ts's was already the
// general case, taking `profile` as a parameter, and prompts.test.ts already
// exercises it against a second profile. So this is that version, with the
// client name lifted out too.
//
// Refusing without a session is the security property worth keeping in ONE
// place: no Shell client may ever reach PostgREST unauthenticated, and a fourth
// client copying the pattern is how that slips.
import { platformClient, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./session";

export async function accessToken(client: string): Promise<string> {
  const session = await platformClient.auth.getSession();
  if (!session) {
    throw new Error(`${client}: no active session, refusing to send request`);
  }
  return session.accessToken;
}

// Returns this client's bound `postgrest(path, init?, profile?)`. `profile`
// defaults to the client's own schema and is overridable per call, which is how
// prompts.ts writes its usage log into `core`.
export function postgrestFor(client: string, defaultProfile: string) {
  return async function postgrest(
    path: string,
    init: RequestInit = {},
    profile = defaultProfile,
  ): Promise<Response> {
    const token = await accessToken(client);
    const headers = new Headers(init.headers);
    headers.set("apikey", SUPABASE_PUBLISHABLE_KEY);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Accept-Profile", profile);
    headers.set("Content-Profile", profile);
    // Only a request that carries a body needs a content type or a return
    // preference; a caller that set its own Prefer keeps it.
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
      if (!headers.has("Prefer")) headers.set("Prefer", "return=representation");
    }
    const res = await fetch(`${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `${client}: ${init.method ?? "GET"} ${path} failed with ${res.status}${body ? `: ${body}` : ""}`,
      );
    }
    return res;
  };
}
