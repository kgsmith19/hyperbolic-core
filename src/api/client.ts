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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const response = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 401) {
    await supabase.auth.signOut();
    window.location.assign("/login");
    throw new ApiError(401, "signed out");
  }
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

export function searchEntities(params: { type_name?: string; text?: string }) {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
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
