// Resolves, verifies, and exports ONLY the owner session into $GITHUB_ENV,
// for jobs whose sole credential need is the owner -- toolbelt-ci.yml's
// Prompt Organizer critical browser journey.
//
// Why not export-test-sessions.mjs, which platform-contract.yml runs: that
// script also mints fixture sessions for TEST_USER_A and TEST_USER_B, because
// the deployed contract suites it serves genuinely need all three. TEST_USER_B
// does not exist in the platform project, so its password grant returns 400
// and takes the whole step down (Promise.all index 1). The browser journey
// never touches the fixture tokens -- it seeds one owner token into
// sessionStorage and drives the UI -- so depending on that script made an
// unrelated missing fixture user a hard prerequisite of the owner-credential
// wiring. This is the narrow version: one session, the one actually used.
import { appendFile } from "node:fs/promises";
import { ANON_KEY, SUPABASE_URL } from "./helpers.mjs";
import { resolveOwnerAccessToken } from "./owner-session.mjs";

const environmentFile = process.env.GITHUB_ENV;
if (!environmentFile) throw new Error("GITHUB_ENV is required");

// Prefer the REFRESH token whenever one is configured; pass the stored access
// token only as a fallback for a deploy that has not provisioned a refresh one.
//
// This ordering is load-bearing, and getting it backwards is not hypothetical.
// resolveOwnerAccessToken() returns a supplied access token VERBATIM, without
// validating it -- so handing it both credentials means the stored snapshot
// always wins and the refresh exchange never runs. That snapshot expires in
// about an hour. This step passed at 18:33 and failed at 19:04 with a 401 on
// the identical commit for exactly that reason: the stored access token aged
// out between two runs while a perfectly good refresh token sat unused.
//
// Minting from the refresh token at job start is the entire point of this
// step. A stored access token is a photograph of a session; the refresh token
// is the session.
const refreshToken = process.env.TOOLBELT_OWNER_REFRESH_TOKEN?.trim();
const ownerToken = await resolveOwnerAccessToken({
  accessToken: refreshToken ? undefined : process.env.TOOLBELT_OWNER_TOKEN,
  refreshToken,
  supabaseUrl: SUPABASE_URL,
  anonKey: ANON_KEY,
});

// Fails this step outright when the resolved session is not platform.owner(),
// so a wrong credential is reported as itself, here, rather than as an
// unrelated-looking "element(s) not found" three assertions into the journey
// (which is what a fixture-login fallback produces once prompt.* RLS is pinned
// to the real owner).
//
// Deliberately NOT owner-session.mjs's verifyOwnerAccessToken(): that function
// posts to a `platform_owner_subject` RPC which does not exist in the platform
// project and is defined by no migration in this repository -- it returns 404,
// so the helper can never succeed against the real database. Its unit tests
// pass only because they stub fetch and assert against that same invented URL.
// core.is_platform_owner() is the function that actually exists, is already
// granted to `authenticated`, and answers precisely this question:
//   select (select auth.uid()) = (select platform.owner())
const preflight = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_platform_owner`, {
  method: "POST",
  headers: {
    apikey: ANON_KEY,
    Authorization: `Bearer ${ownerToken}`,
    "Content-Type": "application/json",
    // core is not the default exposed schema; same header convention
    // services/llm-handler's core.log_llm_call caller already uses.
    "Content-Profile": "core",
  },
  body: "{}",
});
if (!preflight.ok) {
  // Status only, never the body: a failed auth response can echo credential
  // detail, and this runs in a public-by-default CI log.
  throw new Error(`owner identity preflight failed: ${preflight.status}`);
}
if ((await preflight.json()) !== true) {
  throw new Error(
    "the configured owner credential authenticated successfully but is not platform.owner() -- " +
      "check that TOOLBELT_OWNER_REFRESH_TOKEN belongs to the user pinned in platform.config",
  );
}

await appendFile(environmentFile, `TOOLBELT_OWNER_TOKEN=${ownerToken}\n`, { mode: 0o600 });
