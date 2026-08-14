/**
 * PromptClient (docs/planning/05-d-prompt-organizer.md sections 4 and 6,
 * m4-04): the injection API PO-5 requires -- "when another component
 * requests a prompt by name through the injection API, the system shall
 * serve it without that component holding schema knowledge." `GetPrompt-
 * Options`, `RenderedPrompt`, and the `getPrompt(name, opts?)` signature
 * below are copied close to verbatim from section 6's TypeScript contract;
 * the caching rules in createPromptClient are section 4's, implemented as
 * written, not paraphrased.
 *
 * Construction-API judgment call (flagged per this issue's own instructions,
 * since section 6 shows only the per-call `getPrompt(name, opts?)` shape,
 * not a class/factory constructor): section 6 also says server-side callers
 * "call PostgREST rpc/get_prompt directly with their scoped token," and this
 * package never reads or defaults credentials from the environment
 * (packages/llm/src/types.ts's Credentials section: "every call takes
 * credentials in explicitly"). A bare top-level `getPrompt(name, opts)` with
 * no way to supply a Supabase URL or an access token would have to break
 * that rule (reading an env var) or hide a lazily-initialized singleton
 * behind the first call (hidden global state, worse). Instead this file
 * exports a factory, `createPromptClient(supabaseUrl, getAccessToken,
 * options?)`, mirroring packages/platform-client/src/registry.ts's
 * `createRegistryClient(supabaseUrl, getAccessToken)` -- the one other
 * PostgREST client already in this monorepo -- exactly: two required
 * parameters in the same order, `getAccessToken` re-invoked on every network
 * operation (so token refresh works without reconstructing the client), and
 * the returned client's methods carry the frozen per-call signatures. The
 * one addition beyond registry.ts's exact shape is a third, optional
 * `options` parameter (anonKey override, LRU capacity, latest-tier TTL) --
 * needed because this client, unlike registry.ts, has cache tuning knobs the
 * spec itself makes explicit (128-entry default, 60s default TTL) and this
 * session's own testing bar requires a transport spy, which does not need a
 * fetch-injection hook here because every test patches `globalThis.fetch`,
 * the same idiom packages/platform-client's and packages/llm's own driver
 * tests already use (see tests/cache.test.mjs).
 *
 * Anon-key gap: same posture as registry.ts's own documented judgment call.
 * Prompt RPCs need a PostgREST `apikey` header alongside the caller's
 * bearer token regardless of how valid that token is (Supabase's gateway
 * rejects a request with no `apikey` header at all), and section 6 has no
 * slot for a project-specific key either. This hardcodes the exact same
 * public anon key registry.ts already commits (same Supabase project,
 * `woltgcggxaehtuypkxqk`) as the default, overridable via `options.anonKey`
 * for a different project or a test double.
 */

import { render } from "./prompt-render.ts";

// ---------------------------------------------------------------------------
// Public contract -- 05-d section 6, verbatim.
// ---------------------------------------------------------------------------

export interface GetPromptOptions {
  version?: number; // omit = latest
  variables?: Record<string, string>; // merged over the named config's values
  sections?: string[]; // overrides the named config's sections
  config?: string; // saved configuration name
}

export interface RenderedPrompt {
  text: string; // fully rendered, no unresolved {{VAR}} remains
  version: number; // the version_no actually used
  renderedAt: string; // ISO 8601
}

export interface PromptClientOptions {
  /** Overrides the hardcoded default public anon key (see file header). */
  anonKey?: string;
  /** Capacity of the pinned-version LRU. Default 128 (section 4). */
  maxPinnedEntries?: number;
  /** TTL for `name@latest` entries, in ms. Default 60_000 (section 4). */
  latestTtlMs?: number;
}

export interface PromptClient {
  getPrompt(name: string, opts?: GetPromptOptions): Promise<RenderedPrompt>;
  /** Invalidates the `name@latest` cache tier only; pinned entries never
   * invalidate (section 4's own invalidation rules). */
  invalidate(name: string): void;
}

// ---------------------------------------------------------------------------
// Typed errors (packages/llm/src/errors.ts's existing pattern is the
// createLlmError/LlmError taxonomy for the completion API, keyed by a
// `class` discriminant across a small closed set of retry-relevant classes.
// That shape does not fit here: section 6 names two SPECIFIC, unrelated
// failure modes by name -- "Throws PromptNotFoundError (PT404) |
// MissingVariablesError (PT422, .missing: string[])" -- so this follows the
// more common, equally-established TypeScript convention of one Error
// subclass per named failure instead of inventing a third taxonomy shape.)
// ---------------------------------------------------------------------------

export class PromptNotFoundError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PromptNotFoundError";
  }
}

export class MissingVariablesError extends Error {
  readonly missing: string[];
  constructor(missing: string[], message?: string, options?: { cause?: unknown }) {
    super(message ?? `missing variables: ${missing.join(", ")}`, options);
    this.name = "MissingVariablesError";
    this.missing = missing;
  }
}

// ---------------------------------------------------------------------------
// The anon key. Byte-identical to packages/platform-client/src/registry.ts's
// DEFAULT_ANON_KEY -- same Supabase project, same "public by design, RLS is
// the real boundary" posture (apps/toolbelt/apps/prompt-organizer/config.mjs
// carries the same comment).
// ---------------------------------------------------------------------------

const DEFAULT_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";

const DEFAULT_MAX_PINNED_ENTRIES = 128;
const DEFAULT_LATEST_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// A real, capacity-bounded LRU (not an unbounded Map). get() promotes to
// most-recently-used; set() evicts the least-recently-used entry (the first
// key in Map's insertion-order iteration) once at capacity.
// ---------------------------------------------------------------------------

class Lru<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Cache entries.
//
// A pinned entry stores the raw template body (not a rendered string) plus
// its version_no; it is immutable for process lifetime once written. A
// latest entry adds only its expiry. Both are populated atomically by
// rpc/get_prompt_source, so the client never needs prompt table privileges
// and never combines a rendered RPC response with a later table read.
// ---------------------------------------------------------------------------

interface PinnedEntry {
  body: string;
  versionNo: number;
}

interface LatestEntry extends PinnedEntry {
  expiresAt: number; // epoch ms
}

interface GetPromptRpcResponse {
  text: string;
  version_no: number;
  rendered_at: string;
}

interface GetPromptSourceRpcResponse {
  body: string | null;
  version_no: number;
  not_modified: boolean;
}

interface PostgrestErrorBody {
  code?: string;
  message?: string;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function schemaHeaders(apiKey: string, token: string): Record<string, string> {
  // Both Accept-Profile and Content-Profile are sent on every RPC call --
  // the same convention apps/toolbelt/tests/
  // helpers.mjs's shared rest() helper already uses for every non-public
  // schema request in this monorepo.
  return {
    apikey: apiKey,
    Authorization: `Bearer ${token}`,
    "Accept-Profile": "prompt",
    "Content-Profile": "prompt",
  };
}

function parseMissingVariables(message: string): string[] {
  // Mirrors the SQL RPC's own message format exactly (migration
  // 20260813120000: `raise exception 'missing variables: %',
  // array_to_string(v_missing, ', ')`).
  const match = /^missing variables: (.+)$/.exec(message);
  return match ? (match[1] as string).split(", ") : [];
}

async function callGetPrompt(base: string, apiKey: string, token: string, name: string, opts: GetPromptOptions): Promise<GetPromptRpcResponse> {
  const res = await fetch(`${base}/rest/v1/rpc/get_prompt`, {
    method: "POST",
    headers: { ...schemaHeaders(apiKey, token), "Content-Type": "application/json" },
    body: JSON.stringify({
      p_name: name,
      p_version: opts.version ?? null,
      p_config: opts.config ?? null,
      p_values: opts.variables ?? null,
      p_sections: opts.sections ?? null,
    }),
  });

  return parseGetPromptResponse(await readRpcResponse<unknown>(res, "get_prompt"), opts.version ?? null);
}

async function callGetPromptSource(
  base: string,
  apiKey: string,
  token: string,
  name: string,
  version: number | null,
  ifVersion: number | null,
): Promise<GetPromptSourceRpcResponse> {
  const res = await fetch(`${base}/rest/v1/rpc/get_prompt_source`, {
    method: "POST",
    headers: { ...schemaHeaders(apiKey, token), "Content-Type": "application/json" },
    body: JSON.stringify({ p_name: name, p_version: version, p_if_version: ifVersion }),
  });
  return parseGetPromptSourceResponse(await readRpcResponse<unknown>(res, "get_prompt_source"), version);
}

function parseGetPromptSourceResponse(value: unknown, expectedVersion: number | null): GetPromptSourceRpcResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("prompt-client: invalid get_prompt_source response");
  }
  const source = value as Record<string, unknown>;
  const validVersion = Number.isSafeInteger(source.version_no) && (source.version_no as number) > 0;
  const validBody = source.not_modified === true ? source.body === null : source.not_modified === false && typeof source.body === "string";
  const matchesRequestedVersion = expectedVersion === null || source.version_no === expectedVersion;
  if (!validVersion || !validBody || !matchesRequestedVersion) {
    throw new Error("prompt-client: invalid get_prompt_source response");
  }
  return source as unknown as GetPromptSourceRpcResponse;
}

function parseGetPromptResponse(value: unknown, expectedVersion: number | null): GetPromptRpcResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("prompt-client: invalid get_prompt response");
  }
  const rendered = value as Record<string, unknown>;
  const validVersion = Number.isSafeInteger(rendered.version_no) && (rendered.version_no as number) > 0;
  const validRenderedAt =
    typeof rendered.rendered_at === "string" &&
    ISO_TIMESTAMP_RE.test(rendered.rendered_at) &&
    Number.isFinite(Date.parse(rendered.rendered_at));
  const matchesRequestedVersion = expectedVersion === null || rendered.version_no === expectedVersion;
  if (typeof rendered.text !== "string" || !validVersion || !validRenderedAt || !matchesRequestedVersion) {
    throw new Error("prompt-client: invalid get_prompt response");
  }
  return rendered as unknown as GetPromptRpcResponse;
}

async function readRpcResponse<T>(res: Response, rpcName: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let body: PostgrestErrorBody = {};
    try {
      body = JSON.parse(text) as PostgrestErrorBody;
    } catch {
      // Preserve the raw response in the generic error below.
    }
    const message = body.message ?? `prompt-client: rpc/${rpcName} failed with ${res.status}`;
    if (res.status === 404 && body.code === "PT404") {
      throw new PromptNotFoundError(message);
    }
    const missing = parseMissingVariables(message);
    if (res.status === 422 && body.code === "PT422" && missing.length > 0) {
      throw new MissingVariablesError(missing, message);
    }
    throw new Error(`prompt-client: rpc/${rpcName} failed with ${res.status}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// createPromptClient
// ---------------------------------------------------------------------------

export function createPromptClient(supabaseUrl: string, getAccessToken: () => Promise<string>, options: PromptClientOptions = {}): PromptClient {
  const base = supabaseUrl.replace(/\/+$/, "");
  const apiKey = options.anonKey ?? DEFAULT_ANON_KEY;
  const maxPinnedEntries = options.maxPinnedEntries ?? DEFAULT_MAX_PINNED_ENTRIES;
  const latestTtlMs = options.latestTtlMs ?? DEFAULT_LATEST_TTL_MS;

  if (!Number.isSafeInteger(maxPinnedEntries) || maxPinnedEntries <= 0) {
    throw new RangeError("prompt-client: maxPinnedEntries must be a positive integer");
  }
  if (!Number.isSafeInteger(latestTtlMs) || latestTtlMs <= 0) {
    throw new RangeError("prompt-client: latestTtlMs must be a positive integer");
  }

  const pinnedCache = new Lru<string, PinnedEntry>(maxPinnedEntries);
  const latestCache = new Map<string, LatestEntry>();
  const latestFlights = new Map<string, Promise<LatestEntry>>();
  const latestGenerations = new Map<string, number>();

  function toRendered(rpc: GetPromptRpcResponse): RenderedPrompt {
    return { text: rpc.text, version: rpc.version_no, renderedAt: rpc.rendered_at };
  }

  // Client-side rendering from the cached template (section 4, third
  // bullet): applied on every cache hit whenever variables/sections are
  // supplied, using the exact pure render() model section 8 specifies.
  // Never touches the network.
  function renderFromCache(body: string, versionNo: number, opts: GetPromptOptions): RenderedPrompt {
    const result = render(body, opts.variables ?? {}, opts.sections ?? []);
    if (!result.ok) throw new MissingVariablesError(result.missing);
    return { text: result.text, version: versionNo, renderedAt: new Date().toISOString() };
  }

  function sourceEntry(source: GetPromptSourceRpcResponse): PinnedEntry {
    if (source.not_modified || source.body === null) {
      throw new Error("prompt-client: rpc/get_prompt_source returned no body for an unconditional read");
    }
    return { body: source.body, versionNo: source.version_no };
  }

  // A per-call saved `config` name is resolved server-side (get_prompt
  // merges its values/sections before rendering); this client does not
  // cache configuration rows, so a call naming one always goes to the
  // network -- section 4's cache key is `name@version_no` / `name@latest`
  // only, with no config-aware tier. Documented scoping choice, not an
  // oversight: it keeps the cache exactly the two tiers section 4 specifies.
  async function getPinned(name: string, opts: GetPromptOptions, version: number): Promise<RenderedPrompt> {
    const key = `${name}@${version}`;
    const cached = opts.config === undefined ? pinnedCache.get(key) : undefined;
    if (cached) {
      return renderFromCache(cached.body, cached.versionNo, opts);
    }

    const token = await getAccessToken();
    if (opts.config !== undefined) {
      return toRendered(await callGetPrompt(base, apiKey, token, name, opts));
    }

    const entry = sourceEntry(await callGetPromptSource(base, apiKey, token, name, version, null));
    pinnedCache.set(key, entry);
    return renderFromCache(entry.body, entry.versionNo, opts);
  }

  async function loadLatest(name: string, cached: LatestEntry | undefined, generation: number): Promise<LatestEntry> {
    const token = await getAccessToken();
    let source: GetPromptSourceRpcResponse;
    try {
      source = await callGetPromptSource(base, apiKey, token, name, null, cached?.versionNo ?? null);
    } catch (error) {
      // A failed conditional must never make stale data eligible again. In
      // particular, PT404 is how archival invalidates a warm latest entry.
      if ((latestGenerations.get(name) ?? 0) === generation) latestCache.delete(name);
      throw error;
    }

    if (cached && source.not_modified) {
      if (source.body !== null || source.version_no !== cached.versionNo) {
        if ((latestGenerations.get(name) ?? 0) === generation) latestCache.delete(name);
        throw new Error("prompt-client: rpc/get_prompt_source returned an invalid not-modified response");
      }
      if ((latestGenerations.get(name) ?? 0) === generation) cached.expiresAt = Date.now() + latestTtlMs;
      return cached;
    }

    const entry = sourceEntry(source);
    const latest = { ...entry, expiresAt: Date.now() + latestTtlMs };
    if ((latestGenerations.get(name) ?? 0) === generation) latestCache.set(name, latest);
    return latest;
  }

  async function getLatest(name: string, opts: GetPromptOptions): Promise<RenderedPrompt> {
    if (opts.config !== undefined) {
      const token = await getAccessToken();
      return toRendered(await callGetPrompt(base, apiKey, token, name, opts));
    }

    const cached = latestCache.get(name);
    if (cached && Date.now() < cached.expiresAt) {
      return renderFromCache(cached.body, cached.versionNo, opts);
    }

    let flight = latestFlights.get(name);
    if (!flight) {
      const generation = latestGenerations.get(name) ?? 0;
      let tracked: Promise<LatestEntry>;
      tracked = loadLatest(name, cached, generation).finally(() => {
        if (latestFlights.get(name) === tracked) latestFlights.delete(name);
      });
      latestFlights.set(name, tracked);
      flight = tracked;
    }

    const latest = await flight;
    return renderFromCache(latest.body, latest.versionNo, opts);
  }

  return {
    getPrompt(name: string, opts: GetPromptOptions = {}): Promise<RenderedPrompt> {
      return opts.version !== undefined ? getPinned(name, opts, opts.version) : getLatest(name, opts);
    },
    invalidate(name: string): void {
      latestGenerations.set(name, (latestGenerations.get(name) ?? 0) + 1);
      latestCache.delete(name);
      latestFlights.delete(name);
    },
  };
}
