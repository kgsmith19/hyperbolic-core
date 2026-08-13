// The one place the app talks HTTP. Components never call fetch directly.
//
// m2-08: the bearer token now comes from `platformClient` (src/lib/session.ts,
// @hyperbolic/platform-client) instead of this module's own `supabase`
// client -- LO-2b's "no local sign-in call" is about more than deleting
// Login.tsx; this was the other place a LifeOS-owned Supabase client lived.
import { platformClient } from "../lib/session";
import type { components } from "./types.gen";

export type TypeDefinition = components["schemas"]["TypeDefinition"];
export type Entity = components["schemas"]["Entity"];
export type EntityView = components["schemas"]["EntityView"];
export type Event = components["schemas"]["Event"];
export type CaptureResult = components["schemas"]["CaptureResult"];
export type ForgetResult = components["schemas"]["ForgetResult"];
export type ProposalView = components["schemas"]["ProposalView"];
export type DecisionResult = components["schemas"]["DecisionResult"];
export type EmittedDraft = components["schemas"]["EmittedDraft"];

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const session = await platformClient.auth.getSession();
  return session ? { Authorization: `Bearer ${session.accessToken}` } : {};
}

// A 401 means the session is gone; every request path hands the operator
// back to the Shell's login the same way -- "/login" is root-relative
// (the Shell owns "/", this zone is mounted at "/life", ADR-02's one
// origin), not a route inside this bundle, so this is a real browser
// navigation, never a client-side one.
async function signOutOn401(response: Response): Promise<void> {
  if (response.status !== 401) return;
  await platformClient.auth.signOut();
  window.location.assign("/login");
  throw new ApiError(401, "signed out");
}

// 05-a section 4 / 10-cicd-deployment.md section 4: the one-origin route
// table proxies "/life/api/*" to this API on the SAME origin the frontend
// is served from, so the correct default is a same-origin relative path,
// not an absolute URL. VITE_API_URL still overrides it (frontend/.env.example)
// for local dev against a backend that isn't reachable at that path (e.g.
// `vite dev`'s own server has no "/life/api" proxy of its own).
const API_BASE = import.meta.env.VITE_API_URL || "/life/api";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(await authHeader()),
    },
  });
  await signOutOn401(response);
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: { detail?: string }) => body.detail ?? response.statusText)
      .catch(() => response.statusText);
    throw new ApiError(response.status, detail);
  }
  return response.json() as Promise<T>;
}

export const health = () => api<{ status: string }>("/healthz");
export const listTypes = () => api<TypeDefinition[]>("/types");
export const getEntity = (id: string) => api<EntityView>(`/entities/${id}`);
export const getHistory = (id: string) =>
  api<Event[]>(`/entities/${id}/history`);

export function searchEntities(params: {
  type_name?: string;
  text?: string;
  filters?: Record<string, string>;
}) {
  const { filters, ...rest } = params;
  const query = new URLSearchParams(
    Object.entries({
      ...rest,
      ...(filters ? { filters: JSON.stringify(filters) } : {}),
    }).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
  return api<Entity[]>(`/search?${query}`);
}

export function captureEntity(body: {
  type_name: string;
  attributes: Record<string, unknown>;
}) {
  return api<CaptureResult>("/capture", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function forgetEntity(id: string) {
  return api<ForgetResult>(`/entities/${id}/forget`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

// ADR 018: a proposal's draft `body` rides along only while state is
// "proposed" — reading it is the prerequisite an approval echoes back as
// `draft_digest`. Once decided, the letter is reachable only through
// getApprovedDraft, the one function that hands a draft out.
export const listProposals = () => api<ProposalView[]>("/action-proposals");

export function approveProposal(id: string, draft_digest: string) {
  return api<DecisionResult>(`/action-proposals/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ draft_digest }),
  });
}

export function rejectProposal(id: string) {
  return api<DecisionResult>(`/action-proposals/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export const getApprovedDraft = (id: string) =>
  api<EmittedDraft>(`/action-proposals/${id}/draft`);

export type ChatCitations = {
  entity_ids: string[];
  event_ids: string[];
  methods: string[];
};
export type ChatFrame =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | {
      type: "done";
      citations: ChatCitations;
      latency: { model_ms: number; tool_ms: number; total_ms: number };
      model: string;
      stop_reason: string;
    }
  | { type: "error"; detail: string };

export function parseSseChunk(
  buffer: string,
  emit: (frame: ChatFrame) => void,
): string {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event && data) emit({ type: event, ...JSON.parse(data) } as ChatFrame);
  }
  return rest;
}

export async function streamChat(
  messages: { role: "user" | "assistant"; content: string }[],
  onFrame: (frame: ChatFrame) => void,
): Promise<void> {
  const response = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    body: JSON.stringify({ messages }),
    headers: {
      "Content-Type": "application/json",
      ...(await authHeader()),
    },
  });
  await signOutOn401(response);
  if (!response.ok || !response.body)
    throw new ApiError(response.status, response.statusText);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = parseSseChunk(
      buffer + decoder.decode(value, { stream: true }),
      onFrame,
    );
  }
}
