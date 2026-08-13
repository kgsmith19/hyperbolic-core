// Shell-side registry discovery (m3-04, docs/planning/05-c-toolbelt.md
// section 4.3): the one hook every registry-driven surface in the Shell
// consumes -- src/pages/tools.tsx (the full catalog) and
// src/components/protected-layout.tsx (the command palette's tool entries,
// 05-a section 5) both call this same module. Neither hardcodes a tool list;
// both render exactly whatever `registryClient.listTools` returns (TB-2).
import { useEffect, useState } from "react";
import type { RegisteredTool, RegistryFilter } from "@hyperbolic/platform-client";
import { registryClient } from "./session";

// The Shell's one opinion about which statuses are discoverable at all
// (05-c section 4.3: "filtered to status in ('building','live')"). A module-
// level constant, not an inline object literal at each call site, so its
// object identity is stable across renders -- useRegisteredTools' effect
// depends on it, and a fresh `{ status: [...] }` literal every render would
// otherwise re-fire the fetch every render.
export const DISCOVERABLE_STATUS: RegistryFilter = { status: ["building", "live"] };

export interface RegistryListState {
  status: "loading" | "ready" | "error";
  tools: RegisteredTool[];
  errorMessage: string | null;
  retry: () => void;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Dedupes CONCURRENT fetches for the same filter (not a time-based cache --
// entries are removed the instant the request settles, so a later
// navigation always gets a fresh read, never stale data from an earlier
// visit). This exists because the same filter is requested from two
// independent mount points on most page loads -- ProtectedLayout (palette
// tool entries, every route) and ToolsPage (the full catalog, only on
// /tools) -- and collapsing that into one real network round trip matters
// for the registry list query's own p95 <= 200ms budget (05-c section 10).
// Mirrors src/lib/health.ts's own documented precedent for the alternative
// (accepting the duplicate call as a "deliberate, cheap simplification"):
// here the fix is just as cheap, so it's taken.
const inflight = new Map<string, Promise<RegisteredTool[]>>();

function keyFor(filter?: RegistryFilter): string {
  return JSON.stringify({
    status: filter?.status ? [...filter.status].sort() : undefined,
    kind: filter?.kind ? [...filter.kind].sort() : undefined,
  });
}

function fetchTools(filter?: RegistryFilter): Promise<RegisteredTool[]> {
  const key = keyFor(filter);
  let pending = inflight.get(key);
  if (!pending) {
    pending = registryClient.listTools(filter).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * Fetches the registry list once per (filter, enabled, retry) change.
 * `enabled: false` skips the fetch entirely (e.g. protected-layout.tsx while
 * the session isn't signed in yet) without needing a conditional hook call,
 * which would violate the rules of hooks.
 */
export function useRegisteredTools(
  filter: RegistryFilter = DISCOVERABLE_STATUS,
  options: { enabled?: boolean } = {}
): RegistryListState {
  const enabled = options.enabled ?? true;
  const [tools, setTools] = useState<RegisteredTool[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setErrorMessage(null);

    fetchTools(filter)
      .then((next) => {
        if (cancelled) return;
        setTools(next);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(messageFor(error));
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filter is a
    // stable reference by contract (module-level constant, e.g.
    // DISCOVERABLE_STATUS); see this function's own doc comment.
  }, [enabled, filter, nonce]);

  return {
    status,
    tools,
    errorMessage,
    retry: () => setNonce((n) => n + 1),
  };
}

export interface RouteSplit {
  /** Rows with a non-null `route`: rendered as navigation entries. */
  navTools: RegisteredTool[];
  /** Rows with a null `route`: rendered on the tools status page only. */
  statusTools: RegisteredTool[];
}

/**
 * The other of the two places this issue's testing bar names as where a bug
 * could silently leak or hide a tool (the first is
 * packages/platform-client/src/registry.ts's buildListToolsParams).
 *
 * `status === "retired"` is excluded here as a second, independent
 * enforcement of TB-6 ("the Shell shall not render it in navigation") --
 * defense in depth on top of DISCOVERABLE_STATUS already scoping the query
 * server-side. A regression in either place alone (a broken filter upstream,
 * or a future caller that passes an unfiltered list into this function) is
 * still caught by the other.
 */
export function splitByRoute(tools: readonly RegisteredTool[]): RouteSplit {
  const navTools: RegisteredTool[] = [];
  const statusTools: RegisteredTool[] = [];
  for (const tool of tools) {
    if (tool.status === "retired") continue;
    if (tool.route) {
      navTools.push(tool);
    } else {
      statusTools.push(tool);
    }
  }
  return { navTools, statusTools };
}
