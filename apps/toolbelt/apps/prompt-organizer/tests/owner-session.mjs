export async function resolveOwnerAccessToken({
  accessToken,
  refreshToken,
  supabaseUrl,
  anonKey,
  fetchImpl = fetch,
}) {
  const direct = accessToken?.trim();
  if (direct) {
    if (/\r|\n/.test(direct)) throw new Error("TOOLBELT_OWNER_TOKEN contains a newline");
    return direct;
  }

  const refresh = refreshToken?.trim();
  if (!refresh) {
    throw new Error(
      "TOOLBELT_OWNER_REFRESH_TOKEN is required (TOOLBELT_OWNER_TOKEN is accepted only as a short-lived compatibility fallback)",
    );
  }
  if (/\r|\n/.test(refresh)) throw new Error("TOOLBELT_OWNER_REFRESH_TOKEN contains a newline");

  const response = await fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!response.ok) {
    throw new Error(`owner refresh-token exchange failed: ${response.status}`);
  }
  const body = await response.json().catch(() => null);
  const token = body?.access_token;
  if (typeof token !== "string" || token.trim() === "" || /\r|\n/.test(token)) {
    throw new Error("owner refresh-token exchange returned an invalid access token");
  }
  return token;
}

export function parseJwtSubject(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("owner access token is not a JWT");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("owner access token has invalid JWT claims");
  }
  if (typeof claims.sub !== "string" || claims.sub.trim() === "") {
    throw new Error("owner access token has no subject");
  }
  return claims.sub;
}

export async function verifyOwnerAccessToken({ token, supabaseUrl, anonKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/platform_owner_subject`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`owner identity preflight failed: ${response.status}`);
  const ownerSubject = await response.json().catch(() => null);
  if (ownerSubject !== parseJwtSubject(token)) {
    throw new Error("configured owner credential does not match platform.owner()");
  }
  return ownerSubject;
}
