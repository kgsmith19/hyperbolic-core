// ACC status card data (docs/planning/05-b-acc.md section 5): "V1 Shell
// footprint is exactly one read (GET /api/process/status) for the /acc
// status card ... the card degrades to 'ACC unreachable' when the operator
// machine is not the browsing machine."
//
// Judgment call, flagged explicitly (no planning-doc section pins this down
// for the Shell side): this fetch carries no X-ACC-Token. ACC's shipped
// session-credential contract (05-b section 4, gui/README.md "Session
// credential") requires that header on every /api/* route, but the token
// only ever reaches a browser via ACC's OWN UI reading its startup URL
// fragment (gui/README.md "Browser bootstrap") -- there is no bootstrap path
// for the Shell to obtain it, and 05-b section 4's "Shell relationship"
// paragraph explicitly defers the cross-origin grant ACC needs to accept
// Shell-issued requests at all ("ACC_ALLOWED_ORIGIN ... ships with the
// absorption step, not before"). Practically: today, any fetch from the
// Shell's origin to ACC's loopback API is either same-origin-only reachable
// (operator machine, but still 401s with no token) or blocked by the
// browser's CORS policy entirely (any other machine) -- both cases surface
// to fetch() as an opaque failure, which is exactly the "ACC unreachable"
// state this card must render. Sending a token this module doesn't have
// isn't an option; a 401 is treated the same as a network failure below,
// which is the correct degrade either way until ACC-5's CORS grant and a
// real Shell-side bootstrap exist.
import { useEffect, useState } from "react";

// Optional chaining on import.meta.env itself, not just the property: this
// module is imported both by the Vite-built app (where import.meta.env is
// populated) and directly by e2e/chrome.spec.ts under Playwright's own
// plain-Node TypeScript loader (where import.meta.env is undefined
// entirely, not just missing individual keys).
export const ACC_BASE_URL = (import.meta.env?.VITE_ACC_API || "http://127.0.0.1:43117").replace(/\/+$/, "");
export const ACC_STATUS_URL = `${ACC_BASE_URL}/api/process/status`;

/** The subset of gui/README.md's `/api/process/status` shape 05-b section 5 names for the Shell. */
export interface AccProcessStatus {
  tier: { tier: "green" | "amber" | "red"; pct?: number } | null;
  weekText: string;
  stopped: boolean;
}

export type AccStatusResult =
  | { state: "loading" }
  | { state: "ok"; data: AccProcessStatus }
  | { state: "unreachable" };

const DEFAULT_TIMEOUT_MS = 4000;

const ACC_TIERS = new Set(["green", "amber", "red"]);

/**
 * Finding #76 (PR #8 security review): a 200 response's body was trusted
 * with a blind `as AccProcessStatus` type assertion -- no runtime check --
 * and acc-status-card.tsx renders `.tier`/`.stopped`/`.weekText` straight
 * off it. This app has no error boundary anywhere (confirmed by grep for
 * ErrorBoundary/componentDidCatch), so a malformed body from ACC (a bug on
 * ACC's own side, a proxy/gateway returning something ACC never sent, or
 * simply a future ACC response-shape change this Shell hasn't caught up
 * with yet) would otherwise be a render crash, not a graceful degrade.
 *
 * A hand-written guard is deliberately enough here -- this shape is small
 * and well-known (05-b section 5), not worth a schema-validation
 * dependency for.
 */
function isAccProcessStatus(value: unknown): value is AccProcessStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.weekText !== "string") return false;
  if (typeof candidate.stopped !== "boolean") return false;

  const tier = candidate.tier;
  if (tier === null) return true;
  if (typeof tier !== "object") return false;
  const tierCandidate = tier as Record<string, unknown>;
  if (typeof tierCandidate.tier !== "string" || !ACC_TIERS.has(tierCandidate.tier)) return false;
  if (tierCandidate.pct !== undefined && typeof tierCandidate.pct !== "number") return false;

  return true;
}

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

    fetch(ACC_STATUS_URL, { signal: controller.signal })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setResult({ state: "unreachable" });
          return;
        }
        const data: unknown = await res.json();
        if (cancelled) return;
        if (!isAccProcessStatus(data)) {
          // Same degrade as a network failure/timeout below (05-b section
          // 5's one documented "ACC unreachable" state) -- reusing it
          // exactly rather than inventing a second error state, per
          // Finding #76's own fix guidance.
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
