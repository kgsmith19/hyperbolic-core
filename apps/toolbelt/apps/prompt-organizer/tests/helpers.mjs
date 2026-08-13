import {
  login,
  primaryToken,
  rest as sharedRest,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  TEST_USER_A,
  TEST_USER_B,
} from "../../../tests/helpers.mjs";

export { login, SUPABASE_URL };
export const ANON_KEY = SUPABASE_ANON_KEY;
export const USER_A = TEST_USER_A;
export const USER_B = TEST_USER_B;

// Re-exported, not reimplemented: this is the same TOOLBELT_OWNER_TOKEN
// mechanism apps/toolbelt/tests/helpers.mjs already uses for the root
// suite's positive-path tests, now threaded to Prompt Organizer so its
// tests stop being silently RLS-denied once prompt.* RLS is pinned to the
// real owner (20260812180000_prompt_owner_pin.sql) and a live owner token
// is actually supplied. Falls back to the TEST_USER_A fixture login when
// TOOLBELT_OWNER_TOKEN is unset (today, in this sandbox, and in any CI run
// before the secret is set) -- see primaryToken()'s own comment in the root
// helpers.mjs for the full fallback rationale. Use this for any test whose
// point is "this succeeds for the legitimate owner" (positive CRUD/render
// paths). Do NOT use it for a test whose point is that a non-owner fixture
// is denied -- those must keep calling login(USER_A) / login(USER_B)
// directly, or they stop proving what they claim to prove.
export { primaryToken };

export async function rest(path, { token, method = "GET", body } = {}) {
  return sharedRest("prompt", path, { token, method, body });
}
