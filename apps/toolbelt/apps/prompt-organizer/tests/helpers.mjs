import {
  login,
  primaryToken,
  rest as sharedRest,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  TEST_USER_A,
  TEST_USER_B,
} from "../../../tests/helpers.mjs";

export { login, primaryToken, SUPABASE_URL };
export const ANON_KEY = SUPABASE_ANON_KEY;
export const USER_A = TEST_USER_A;
export const USER_B = TEST_USER_B;

// Positive-path deployed tests call primaryToken(); explicit isolation tests
// call login(USER_A/USER_B) so those fixtures remain genuine non-owner users.

export async function rest(path, { token, method = "GET", body } = {}) {
  return sharedRest("prompt", path, { token, method, body });
}
