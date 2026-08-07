import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.mjs";

// Fixed test-fixture users, pre-confirmed once (see docs/notes/2026-08-06-supabase-project-topology.md
// and SPEC-0000 ASM-003). Not real people; email-confirmation is disabled for
// them only, by direct row update, not a project-wide setting change.
export const TEST_USER_A = { email: "kylegsmith19+toolbelt-test-a@gmail.com", password: "Test-Passw0rd-A1!" };
export const TEST_USER_B = { email: "kylegsmith19+toolbelt-test-b@gmail.com", password: "Test-Passw0rd-B1!" };

export async function login(user) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(user),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login failed for ${user.email}: ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
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
