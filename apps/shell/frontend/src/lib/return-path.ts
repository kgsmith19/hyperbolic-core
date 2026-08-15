// Deep-link return-after-login (SH-2b, docs/planning/05-a-hyperbolic-core.md
// section 12: "When login succeeds from a gated deep link, the Shell shall
// navigate to the originally requested path.").
//
// The login page's own `?return=` query param is attacker-influenceable --
// anyone can hand an operator a link to `/login?return=<anything>` -- so
// this is the one place that value is trusted from before it is ever handed
// to react-router's `navigate()`. Only a same-document, path-relative target
// is ever returned; anything else (a protocol-relative URL, an absolute
// URL, a `javascript:` scheme, a target that would just bounce back to
// `/login` itself) falls back to "/".
const FALLBACK_PATH = "/";

/**
 * Validates and normalizes a `return=` query-param value into a safe
 * same-origin path to hand to `navigate()`. Never throws; always resolves to
 * a usable in-app path (falling back to "/" for anything it cannot trust).
 */
export function sanitizeReturnPath(raw: string | null | undefined): string {
  if (!raw) {
    return FALLBACK_PATH;
  }

  // Must be a bare path reference: exactly one leading "/", no scheme
  // before it. "//host/path" is a protocol-relative URL that browsers
  // resolve against a DIFFERENT origin, not a same-document path.
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return FALLBACK_PATH;
  }

  // Backslashes: several browsers normalize a leading "/\" the same way as
  // "//", turning what looks like a path into a protocol-relative URL to
  // another origin. Reject outright rather than trying to special-case it.
  if (raw.includes("\\")) {
    return FALLBACK_PATH;
  }

  // Never redirect back into the login route itself -- that would either
  // loop (a fresh `?return=` gets appended) or silently swallow the
  // operator's real destination.
  if (raw === "/login" || raw.startsWith("/login/") || raw.startsWith("/login?")) {
    return FALLBACK_PATH;
  }

  return raw;
}
