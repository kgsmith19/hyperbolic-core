// The one place the app talks HTTP. Components never call fetch directly.
import { supabase } from "../auth/supabase";
import type { components } from "./types.gen";

export type TypeDefinition = components["schemas"]["TypeDefinition"];
export type Entity = components["schemas"]["Entity"];
export type EntityView = components["schemas"]["EntityView"];
export type Event = components["schemas"]["Event"];
export type CaptureResult = components["schemas"]["CaptureResult"];
export type ForgetResult = components["schemas"]["ForgetResult"];

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// A 401 means the session is gone; every request path hands the user back to
// login the same way.
async function signOutOn401(response: Response): Promise<void> {
  if (response.status !== 401) return;
  await supabase.auth.signOut();
  window.location.assign("/login");
  throw new ApiError(401, "signed out");
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
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
  const response = await fetch(`${import.meta.env.VITE_API_URL}/chat`, {
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
