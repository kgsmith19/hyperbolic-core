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
import { resolveOwnerAccessToken, verifyOwnerAccessToken } from "./owner-session.mjs";

const environmentFile = process.env.GITHUB_ENV;
if (!environmentFile) throw new Error("GITHUB_ENV is required");

// Prefers a supplied access token, otherwise exchanges the long-lived refresh
// token for a fresh one. Minting at job start is the point: a hand-pasted
// access token expires in about an hour, and its expiry is indistinguishable
// from never having set it at all.
const ownerToken = await resolveOwnerAccessToken({
  accessToken: process.env.TOOLBELT_OWNER_TOKEN,
  refreshToken: process.env.TOOLBELT_OWNER_REFRESH_TOKEN,
  supabaseUrl: SUPABASE_URL,
  anonKey: ANON_KEY,
});

// Fails this step outright when the resolved session is not platform.owner(),
// so a wrong credential is reported as itself, here, rather than as an
// unrelated-looking "element(s) not found" three assertions into the journey
// (which is what a fixture-login fallback produces once prompt.* RLS is pinned
// to the real owner).
await verifyOwnerAccessToken({ token: ownerToken, supabaseUrl: SUPABASE_URL, anonKey: ANON_KEY });

await appendFile(environmentFile, `TOOLBELT_OWNER_TOKEN=${ownerToken}\n`, { mode: 0o600 });
