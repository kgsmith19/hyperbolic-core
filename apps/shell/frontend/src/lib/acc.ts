// ACC status card data (docs/planning/05-b-acc.md section 5): "V1 Shell
// footprint is exactly one read (GET /api/process/status) for the /acc
// status card ... the card degrades to 'ACC unreachable' when the operator
// machine is not the browsing machine."
//
// ACC prints an optional Shell bootstrap URL when ACC_ALLOWED_ORIGIN is set.
// Its fragment is consumed into this tab's sessionStorage, stripped before
// the first request, and then sent as X-ACC-Token. A token is never a build
// variable or durable browser credential. ACC still binds loopback and grants
// CORS/PNA to one exact configured Shell origin only.
import { useEffect, useState } from "react";

// Optional chaining on import.meta.env itself, not just the property: this
// module is imported both by the Vite-built app (where import.meta.env is
// populated) and directly by e2e/chrome.spec.ts under Playwright's own
// plain-Node TypeScript loader (where import.meta.env is undefined
// entirely, not just missing individual keys).
export const ACC_BASE_URL = (import.meta.env?.VITE_ACC_API || "http://127.0.0.1:43117").replace(/\/+$/, "");
export const ACC_STATUS_URL = `${ACC_BASE_URL}/api/process/status`;
export const ACC_TOKEN_STORAGE_KEY = "hyperbolic-shell-acc-token";
const ACC_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function readStoredAccToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const token = window.sessionStorage.getItem(ACC_TOKEN_STORAGE_KEY) ?? "";
    if (token && !ACC_TOKEN_RE.test(token)) {
      window.sessionStorage.removeItem(ACC_TOKEN_STORAGE_KEY);
      return "";
    }
    return token;
  } catch {
    return "";
  }
}

/** Consumes only the exact ACC bootstrap fragment and always strips attempted credentials. */
function consumeAccTokenBootstrap(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash;
  if (!/(?:^#|&)acc-token(?:=|&|$)/.test(hash)) return readStoredAccToken();

  const match = /^#acc-token=([^&]*)$/.exec(hash);
  let token = "";
  if (match) {
    try {
      const decoded = decodeURIComponent(match[1]);
      if (ACC_TOKEN_RE.test(decoded)) token = decoded;
    } catch {
      // Untrusted percent encoding is handled as an invalid credential.
    }
  }
  try {
    if (token) window.sessionStorage.setItem(ACC_TOKEN_STORAGE_KEY, token);
    else window.sessionStorage.removeItem(ACC_TOKEN_STORAGE_KEY);
  } catch {
    token = "";
  } finally {
    try {
      const url = new URL(window.location.href);
      url.hash = "";
      window.history.replaceState(null, "", url.toString());
    } catch {
      // History replacement is best-effort; auth still fails closed.
    }
  }
  return token;
}

// App imports the ACC page eagerly, so consume before ProtectedLayout can
// redirect a signed-out `/acc#acc-token=...` visit to `/login`. The return
// query carries only `/acc`; the credential remains tab-scoped storage.
consumeAccTokenBootstrap();

/** Builds the authenticated ACC link only at click time so the token is never rendered into the Shell DOM. */
export function authenticatedAccUiUrl(): string {
  const token = readStoredAccToken();
  return token ? `${ACC_BASE_URL}/#acc-token=${encodeURIComponent(token)}` : ACC_BASE_URL;
}

/** The subset of gui/README.md's `/api/process/status` shape 05-b section 5 names for the Shell. */
export interface AccProcessStatus {
  tier: { tier: "green" | "amber" | "red"; pct?: number } | null;
  weekText: string;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAccProcessStatus(value: unknown): AccProcessStatus | null {
  if (!isRecord(value) || typeof value.weekText !== "string" || value.weekText.length > 512) {
    return null;
  }
  if (typeof value.stopped !== "boolean") return null;

  let tier: AccProcessStatus["tier"] = null;
  if (value.tier !== null) {
    if (!isRecord(value.tier)) return null;
    if (value.tier.tier !== "green" && value.tier.tier !== "amber" && value.tier.tier !== "red") {
      return null;
    }
    if (
      value.tier.pct !== undefined &&
      (typeof value.tier.pct !== "number" || !Number.isFinite(value.tier.pct) || value.tier.pct < 0)
    ) {
      return null;
    }
    tier = {
      tier: value.tier.tier,
      ...(value.tier.pct === undefined ? {} : { pct: value.tier.pct }),
    };
  }

  return { tier, weekText: value.weekText, stopped: value.stopped };
}

export type AccStatusResult =
  | { state: "loading" }
  | { state: "ok"; data: AccProcessStatus }
  | { state: "unreachable" };

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Fetches ACC's process status once per mount (plus on-demand via `retry`).
 * Never throws, never rejects outward, and never logs at error level -- a
 * failure here is an EXPECTED degrade (05-b section 5), not an application
 * error, so nothing here is toast-shaped or alarm-styled; see
 * components/acc-status-card.tsx for the rendering side of that same
 * decision.
 */
export function useAccStatus(timeoutMs: number = DEFAULT_TIMEOUT_MS): AccStatusResult & { retry: () => void } {
  const [result, setResult] = useState<AccStatusResult>({ state: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResult({ state: "loading" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const token = consumeAccTokenBootstrap();
    const headers = token ? { "X-ACC-Token": token } : undefined;
    fetch(ACC_STATUS_URL, { signal: controller.signal, headers })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setResult({ state: "unreachable" });
          return;
        }
        const data = parseAccProcessStatus(await res.json());
        if (cancelled) return;
        if (!data) {
          setResult({ state: "unreachable" });
          return;
        }
        setResult({ state: "ok", data });
      })
      .catch(() => {
        // Network failure, CORS rejection, abort/timeout, or a malformed
        // body -- all collapse to the one documented degrade state.
        if (!cancelled) setResult({ state: "unreachable" });
      })
      .finally(() => clearTimeout(timer));

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [timeoutMs, nonce]);

  return { ...result, retry: () => setNonce((n) => n + 1) };
}
