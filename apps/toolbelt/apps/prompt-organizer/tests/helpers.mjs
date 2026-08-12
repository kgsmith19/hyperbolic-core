import {
  login,
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

export async function rest(path, { token, method = "GET", body } = {}) {
  return sharedRest("prompt", path, { token, method, body });
}
