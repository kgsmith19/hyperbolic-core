// Typed client for ACC's loopback API. The contract is ACC's gui/README.md —
// any drift shows up in the e2e contract suite, which runs against a real
// ACC server. Relative URLs: dev goes through Vite's /api proxy, prod is
// same-origin (ACC serves the built dist).
//
// Session credential (ACC-5): the server prints
// `http://127.0.0.1:43117/#acc-token=<value>` once at startup. The fragment
// never reaches the server (that's the point of putting it there instead of
// a query string) — this module reads it off `location.hash` the first time
// it loads, stashes it in sessionStorage so a reload/navigation within the
// tab keeps working, and strips it from the URL immediately so it never
// lingers in browser history. Every request below — GET and POST alike —
// then carries it as `X-ACC-Token`.
const TOKEN_STORAGE_KEY = "acc-gui-token";

function bootstrapTokenFromFragment(): void {
  if (typeof window === "undefined") return; // non-browser eval (tests, SSR-ish tooling)
  const m = /(?:^#|[#&])acc-token=([^&]+)/.exec(window.location.hash);
  if (!m) return;
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, decodeURIComponent(m[1]));
  } finally {
    // Strip the fragment even if storage somehow failed: it must never
    // linger in history either way.
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url.toString());
  }
}
bootstrapTokenFromFragment();

function currentToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export type Directive = {
  id: string; text: string; cwd: string; profile: string;
  status: string; sessionId: string; cycles: number; running: boolean;
  createdAt: string; updatedAt: string;
};
export type RouteVerdict = { path: string | null; label?: string; score?: number; reason?: string; parent?: string | null };
export type Dials = { softK: number; hardK: number; amberTokens: number; redTokens: number; maxFinders: number; allow: string[] };
export type ProcessStatus = {
  tier: { tier: "green" | "amber" | "red"; pct?: number } | null;
  weekText: string; dials: Dials; profiles: string[]; stopped: boolean;
};
export type GuardsStatus = {
  enabled: boolean; secrets: string[]; protected: string[]; projects: string[];
  vaultKeys: string[]; pending: number; trashed: number;
};
export type RunboxItem = { label: string; name: string; summary?: string };
export type LaneStatus = { automation: unknown[]; breaker: { tripped: boolean } };
export type KernelPolicy = {
  harness: string;
  budget: { wallClockMin: number; toolCalls: number; tokens: number };
  hardCaps: { wallClockMin: number };
  autonomy: { window: number; rejectRate: number; factor: number; runs: number };
  checkpointMin: number; alwaysAllowTools: string[]; extraDenyWriteRoots: string[];
};
export type EngineResult = { code?: number; out?: string; error?: string };

async function req<T>(url: string, body?: unknown): Promise<T> {
  // X-ACC-Token is required on every /api/* request, GET and POST alike.
  const headers: Record<string, string> = { "X-ACC-Token": currentToken() };
  const init: RequestInit = { headers };
  if (body !== undefined) {
    init.method = "POST";
    headers["content-type"] = "application/json";
    headers["X-ACC"] = "1";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`ACC API ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  // launch surface
  suggest: (text: string) => req<RouteVerdict>("/api/route/suggest", { text }),
  directives: () => req<Directive[]>("/api/directives"),
  createDirective: (b: { text: string; cwd: string; profile: string }) => req<Directive & { error?: string }>("/api/directives", b),
  launch: (id: string) => req<{ ok?: boolean; pid?: number; error?: string }>("/api/launch", { id }),
  setStatus: (id: string, status: "done" | "paused", why?: string) => req<EngineResult>("/api/directives/status", { id, status, why }),
  note: (id: string, text: string) => req<EngineResult>("/api/directives/note", { id, text }),
  directiveLog: (id: string) => fetch(`/api/directives/log?id=${encodeURIComponent(id)}`, { headers: { "X-ACC-Token": currentToken() } }).then((r) => (r.ok ? r.text() : "(no log yet)")),
  lane: () => req<LaneStatus>("/api/lane/status"),
  // guards / vault / runbox
  guardsStatus: () => req<GuardsStatus>("/api/guards/status"),
  guardsList: () => req<{ pending: RunboxItem[]; trashed: RunboxItem[] }>("/api/guards/list"),
  engine: (verb: string, arg?: string, extra?: object) => req<EngineResult>("/api/guards/engine", { verb, arg, ...extra }),
  preview: (ref: string) => req<{ content?: string; error?: string }>("/api/guards/preview", { ref }),
  vaultImport: (pairs: { key: string; value: string }[]) => req<{ stored?: string[]; error?: string; out?: string }>("/api/guards/vault-import", { pairs }),
  vaultRm: (key: string) => req<EngineResult>("/api/guards/vault-rm", { key }),
  // spending / process
  processStatus: () => req<ProcessStatus>("/api/process/status"),
  saveDials: (d: Dials) => req<{ ok?: boolean; error?: string }>("/api/process/dials", d),
  control: (action: "stop" | "resume" | "fanout") => req<EngineResult & { ok?: boolean }>("/api/process/control", { action }),
  // kernel
  kernelPolicy: () => req<{ kernel: KernelPolicy }>("/api/kernel-policy"),
  saveKernelPolicy: (k: KernelPolicy) => req<{ ok?: boolean; kernel?: KernelPolicy; error?: string }>("/api/kernel-policy", k),
};
