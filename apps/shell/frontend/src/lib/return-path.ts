// Deep-link return-after-login (SH-2b, docs/planning/05-a-hyperbolic-core.md
// section 12: "When login succeeds from a gated deep link, the Shell shall
// navigate to the originally requested path.").
//
// The login page's own `?return=` query param is attacker-influenceable --
// anyone can hand an operator a link to `/login?return=<anything>` -- so
// this is the one place that value is trusted from before it is ever handed
// to a navigator. Only a same-origin, app-root-relative target
// is ever returned; anything else (a protocol-relative URL, an absolute
// URL, a `javascript:` scheme, a target that would just bounce back to
// `/login` itself) falls back to "/".
const FALLBACK_PATH = "/";
const SHELL_ORIGIN_SENTINEL = "https://shell.invalid";

function decodeRouterPathname(pathname: string): string {
  try {
    // React Router decodes each segment, then re-escapes decoded slashes so
    // an encoded separator cannot change route segment boundaries.
    return pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).replaceAll("/", "%2F"))
      .join("/");
  } catch {
    return pathname;
  }
}

/**
 * Validates and normalizes a `return=` query-param value into a safe
 * same-origin path to hand to `navigate()`. Never throws; always resolves to
 * a usable in-app path (falling back to "/" for anything it cannot trust).
 */
export function sanitizeReturnPath(raw: string | null | undefined): string {
  if (!raw) {
    return FALLBACK_PATH;
  }

  // Browsers strip ASCII tabs and newlines while parsing URLs, so a value
  // such as "/\t/host" becomes the protocol-relative "//host". Reject all
  // control characters, plus backslashes (which URL parsers normalize to
  // slashes for special schemes), before resolving the target.
  if (/[\u0000-\u001f\u007f\\]/u.test(raw)) {
    return FALLBACK_PATH;
  }

  let resolved: URL;
  try {
    resolved = new URL(raw, SHELL_ORIGIN_SENTINEL);
  } catch {
    return FALLBACK_PATH;
  }

  // A return target must be app-root-relative and must still resolve to the
  // sentinel origin after browser normalization. This excludes absolute,
  // protocol-relative, scheme, and merely path-relative inputs.
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    resolved.origin !== SHELL_ORIGIN_SENTINEL
  ) {
    return FALLBACK_PATH;
  }

  // Check the browser-normalized pathname, independent of query/fragment,
  // so variants such as `/login#frag` and `/tools/../login` cannot loop.
  // Shell route matching is case-insensitive by default.
  const pathname = decodeRouterPathname(resolved.pathname).toLowerCase();
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    return FALLBACK_PATH;
  }

  return raw;
}
