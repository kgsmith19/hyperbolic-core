import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.mjs";

export { SUPABASE_URL, SUPABASE_ANON_KEY };

// Fixed test-fixture users, pre-confirmed once (see docs/notes/2026-08-06-supabase-project-topology.md
// and SPEC-0000 ASM-003). Not real people; email-confirmation is disabled for
// them only, by direct row update, not a project-wide setting change.
export const TEST_USER_A = { email: "kylegsmith19+toolbelt-test-a@gmail.com", password: "Test-Passw0rd-A1!" };
export const TEST_USER_B = { email: "kylegsmith19+toolbelt-test-b@gmail.com", password: "Test-Passw0rd-B1!" };

const tokenRequests = new Map();

function suppliedToken(user) {
  if (user.email === TEST_USER_A.email) {
    return process.env.TOOLBELT_TEST_TOKEN_A || process.env.PROMPT_TEST_TOKEN_A;
  }
  if (user.email === TEST_USER_B.email) {
    return process.env.TOOLBELT_TEST_TOKEN_B || process.env.PROMPT_TEST_TOKEN_B;
  }
  return undefined;
}

async function requestToken(user) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(user),
    });
    const body = await res.json();
    if (res.ok) return body.access_token;
    if (res.status !== 429 || attempt === 4) {
      throw new Error(`login failed for ${user.email}: ${res.status}`);
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`login failed for ${user.email}`);
}

export async function login(user) {
  const token = suppliedToken(user);
  if (token) return token;
  if (!tokenRequests.has(user.email)) {
    tokenRequests.set(
      user.email,
      requestToken(user).catch((error) => {
        tokenRequests.delete(user.email);
        throw error;
      }),
    );
  }
  return tokenRequests.get(user.email);
}

const OWNER_TOKEN_ENV = "TOOLBELT_OWNER_TOKEN";

// The identity positive-path suites authenticate as (docs/planning/issues/
// m1-07-chore-platform-idp-owner-setup.md; docs/planning/06-supabase-schema.md
// section 5.4, sequence step S3). Falls back to the TEST_USER_A fixture when
// TOOLBELT_OWNER_TOKEN is unset, which is what keeps this suite green today,
// before the owner user exists: under current (pre-re-pin) policies the
// fixture is just another authenticated caller, so the fallback is
// behaviorally identical to the pre-m1-07 suite. That fallback stops being
// sufficient the moment the m1-08 re-pin lands (fixtures lose core/idea/prompt
// access entirely), which is deliberate: CI going red on this suite at that
// point is the signal that TOOLBELT_OWNER_TOKEN still needs to be supplied,
// not a bug to work around.
export async function primaryToken() {
  const owner = process.env[OWNER_TOKEN_ENV];
  if (owner) return owner;
  return login(TEST_USER_A);
}

export async function rest(schema, path, { token, method = "GET", body } = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, "Accept-Profile": schema, "Content-Profile": schema };
  headers.Authorization = `Bearer ${token || SUPABASE_ANON_KEY}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers.Prefer = "return=representation";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
