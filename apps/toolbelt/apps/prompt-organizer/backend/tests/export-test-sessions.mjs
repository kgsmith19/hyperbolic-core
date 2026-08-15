import { appendFile } from "node:fs/promises";
import { ANON_KEY, login, SUPABASE_URL, USER_A, USER_B } from "./helpers.mjs";
import { resolveOwnerAccessToken, verifyOwnerAccessToken } from "./owner-session.mjs";

const environmentFile = process.env.GITHUB_ENV;
if (!environmentFile) throw new Error("GITHUB_ENV is required");

const [fixtureTokenA, fixtureTokenB, ownerToken] = await Promise.all([
  login(USER_A),
  login(USER_B),
  resolveOwnerAccessToken({
    accessToken: process.env.TOOLBELT_OWNER_TOKEN,
    refreshToken: process.env.TOOLBELT_OWNER_REFRESH_TOKEN,
    supabaseUrl: SUPABASE_URL,
    anonKey: ANON_KEY,
  }),
]);

for (const token of [fixtureTokenA, fixtureTokenB, ownerToken]) {
  if (/\r|\n/.test(token)) throw new Error("invalid test token");
}
await verifyOwnerAccessToken({
  token: ownerToken,
  supabaseUrl: SUPABASE_URL,
  anonKey: ANON_KEY,
});

await appendFile(
  environmentFile,
  `TOOLBELT_TEST_TOKEN_A=${fixtureTokenA}\nTOOLBELT_TEST_TOKEN_B=${fixtureTokenB}\n` +
    `PROMPT_TEST_TOKEN_A=${fixtureTokenA}\nPROMPT_TEST_TOKEN_B=${fixtureTokenB}\n` +
    `TOOLBELT_OWNER_TOKEN=${ownerToken}\n`,
  { mode: 0o600 },
);
