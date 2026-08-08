// Shared by every test that calls the live project. Not secret: the anon key
// is designed for client-side exposure; RLS is the boundary
// (docs/SYSTEM-REQUIREMENTS.md SR-05). Same project as toolbelt.
const SUPABASE_URL = "https://woltgcggxaehtuypkxqk.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";

// Project-level fixture users (toolbelt SPEC-0000 ASM-003). Not real people.
export const USER_A = { email: "kylegsmith19+toolbelt-test-a@gmail.com", password: "Test-Passw0rd-A1!" };
export const USER_B = { email: "kylegsmith19+toolbelt-test-b@gmail.com", password: "Test-Passw0rd-B1!" };

export async function login(user) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(user),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login failed for ${user.email}: ${res.status}`);
  return body.access_token;
}

export async function rest(path, { token, method = "GET", body } = {}) {
  const headers = { apikey: ANON_KEY, "Accept-Profile": "prompt", "Content-Profile": "prompt" };
  headers.Authorization = `Bearer ${token || ANON_KEY}`;
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
