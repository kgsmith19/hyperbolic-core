// Shared by every test that calls the live project. Not secret: the anon key
// is designed for client-side exposure; RLS is the boundary
// (docs/SYSTEM-REQUIREMENTS.md SR-05). Same project as toolbelt.
export const SUPABASE_URL = "https://woltgcggxaehtuypkxqk.supabase.co";
export const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";

// Project-level fixture users (toolbelt SPEC-0000 ASM-003). Not real people.
export const USER_A = { email: "kylegsmith19+toolbelt-test-a@gmail.com", password: "Test-Passw0rd-A1!" };
export const USER_B = { email: "kylegsmith19+toolbelt-test-b@gmail.com", password: "Test-Passw0rd-B1!" };

const tokenRequests = new Map();

function suppliedToken(user) {
  if (user.email === USER_A.email) return process.env.PROMPT_TEST_TOKEN_A;
  if (user.email === USER_B.email) return process.env.PROMPT_TEST_TOKEN_B;
  return undefined;
}

async function requestToken(user) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
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
