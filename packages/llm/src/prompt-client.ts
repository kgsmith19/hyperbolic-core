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
 * `rpc/get_prompt` needs a PostgREST `apikey` header alongside the caller's
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
// A pinned entry stores the RAW template body (not a rendered string) plus
// its version_no; it is immutable for process lifetime once written (no TTL
// field at all -- there is nothing to expire). A latest entry additionally
// carries `promptId`, the one piece of information the TTL revalidation
// probe needs and the get_prompt RPC's own response never includes (its
// shape is exactly `{text, version_no, rendered_at}`, section 1.2's OpenAPI
// fragment) -- learned via one supplementary raw `prompt` fetch the first
// time a name@latest entry is populated (section 4's own latency table
// budgets exactly this path: "Raw fetch (GET /rest/v1/prompt single row by
// title)"), and reused for every revalidation after that without needing to
// look it up again.
// ---------------------------------------------------------------------------

interface PinnedEntry {
  body: string;
  versionNo: number;
}

interface LatestEntry {
  promptId: string;
  body: string;
  versionNo: number;
  expiresAt: number; // epoch ms
}

interface GetPromptRpcResponse {
  text: string;
  version_no: number;
  rendered_at: string;
}

interface PostgrestErrorBody {
  code?: string;
  message?: string;
}

function schemaHeaders(apiKey: string, token: string): HeadersInit {
  // Both Accept-Profile and Content-Profile are sent on every call,
  // regardless of verb -- the same convention apps/toolbelt/tests/
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

  if (res.status === 404 || res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as PostgrestErrorBody;
    const message = body.message ?? `prompt-client: rpc/get_prompt failed with ${res.status}`;
    if (res.status === 404) throw new PromptNotFoundError(message);
    throw new MissingVariablesError(parseMissingVariables(message), message);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`prompt-client: rpc/get_prompt failed with ${res.status}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as GetPromptRpcResponse;
}

// Raw, un-rendered single-row fetch by title -- section 4's budgeted "Raw
// fetch" path, used only to learn `id` (and, for the latest tier, the raw
// template body) so future calls can render locally.
async function fetchPromptByTitle(base: string, apiKey: string, token: string, name: string): Promise<{ id: string; body: string } | undefined> {
  const url = `${base}/rest/v1/prompt?title=eq.${encodeURIComponent(name)}&select=id,body&limit=1`;
  const res = await fetch(url, { headers: schemaHeaders(apiKey, token) });
  if (!res.ok) return undefined;
  const rows = (await res.json()) as Array<{ id: string; body: string }>;
  return rows[0];
}

// A pinned version's raw body lives on prompt_version, not the live
// prompt.body (section 1.2/7: a pin survives later edits to the live row).
async function fetchPinnedBody(base: string, apiKey: string, token: string, promptId: string, version: number): Promise<string | undefined> {
  const url = `${base}/rest/v1/prompt_version?prompt_id=eq.${encodeURIComponent(promptId)}&version_no=eq.${version}&select=body&limit=1`;
  const res = await fetch(url, { headers: schemaHeaders(apiKey, token) });
  if (!res.ok) return undefined;
  const rows = (await res.json()) as Array<{ body: string }>;
  return rows[0]?.body;
}

// The cheapest possible revalidation query, section 4's exact shape:
// `GET /rest/v1/prompt_version?prompt_id=eq.<id>&select=version_no&order=
// version_no.desc&limit=1`. version_no stands in for an ETag PostgREST does
// not send on these responses.
//
// KNOWN LIMITATION, found during review of this issue and deliberately NOT
// silently patched here, because closing it changes a protocol 05-d section 4
// pins exactly: this probe cannot observe ARCHIVAL. `prompt.record_version`
// fires `after insert or update of body` (migration 20260807041000), so
// flipping `is_active` to false creates no new version -- the probe keeps
// reporting an unchanged version_no, the TTL is extended, and a `@latest`
// entry for an archived prompt is served for the rest of the process
// lifetime. The server disagrees: get_prompt's latest branch raises PT404
// for an archived prompt (migration 20260813120000), so a cache-warm client
// and a cold one answer the same call differently, permanently.
//
// This matters because archiving is the operator's only deprecation
// mechanism (05-d section 5: "create-new-and-archive-old is the rename
// path") and section 5 puts interactive surfaces on `@latest` -- exactly the
// affected tier. Pinned consumers (the Brain) are unaffected by
// construction. Closing it is a spec decision, not a client one: either
// widen revalidation to read `is_active` (a second cheap query, or a
// `prompt`-side probe), or make archival bump a version.
async function probeVersionNo(base: string, apiKey: string, token: string, promptId: string): Promise<number | undefined> {
  const url = `${base}/rest/v1/prompt_version?prompt_id=eq.${encodeURIComponent(promptId)}&select=version_no&order=version_no.desc&limit=1`;
  const res = await fetch(url, { headers: schemaHeaders(apiKey, token) });
  if (!res.ok) return undefined;
  const rows = (await res.json()) as Array<{ version_no: number }>;
  return rows[0]?.version_no;
}

// ---------------------------------------------------------------------------
// createPromptClient
// ---------------------------------------------------------------------------

export function createPromptClient(supabaseUrl: string, getAccessToken: () => Promise<string>, options: PromptClientOptions = {}): PromptClient {
  const base = supabaseUrl.replace(/\/+$/, "");
  const apiKey = options.anonKey ?? DEFAULT_ANON_KEY;
  const latestTtlMs = options.latestTtlMs ?? DEFAULT_LATEST_TTL_MS;

  const pinnedCache = new Lru<string, PinnedEntry>(options.maxPinnedEntries ?? DEFAULT_MAX_PINNED_ENTRIES);
  const latestCache = new Map<string, LatestEntry>();

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

  // A per-call saved `config` name is resolved server-side (get_prompt
  // merges its values/sections before rendering); this client does not
  // cache configuration rows, so a call naming one always goes to the
  // network -- section 4's cache key is `name@version_no` / `name@latest`
  // only, with no config-aware tier. Documented scoping choice, not an
  // oversight: it keeps the cache exactly the two tiers section 4 specifies.
  async function getPinned(name: string, opts: GetPromptOptions, version: number): Promise<RenderedPrompt> {
    const key = `${name}@${version}`;
    const cached = pinnedCache.get(key);
    if (cached && opts.config === undefined) {
      return renderFromCache(cached.body, cached.versionNo, opts);
    }

    const token = await getAccessToken();
    const rpc = await callGetPrompt(base, apiKey, token, name, opts);

    if (!cached) {
      // Best-effort cache population: failure here never fails the call
      // that's already been satisfied by the RPC above, it just leaves this
      // pinned version uncached (a future call re-tries the same miss path).
      const row = await fetchPromptByTitle(base, apiKey, token, name).catch(() => undefined);
      const body = row ? await fetchPinnedBody(base, apiKey, token, row.id, version).catch(() => undefined) : undefined;
      if (body !== undefined) pinnedCache.set(key, { body, versionNo: rpc.version_no });
    }
    return toRendered(rpc);
  }

  async function getLatest(name: string, opts: GetPromptOptions): Promise<RenderedPrompt> {
    const now = Date.now();
    let cached = latestCache.get(name);
    let token: string | undefined;

    if (cached && now >= cached.expiresAt) {
      token = await getAccessToken();
      const probed = await probeVersionNo(base, apiKey, token, cached.promptId).catch(() => undefined);
      if (probed !== undefined && probed === cached.versionNo) {
        // Unchanged version_no: reuse the cached template body verbatim,
        // zero body re-fetch -- only the probe query above touched the
        // network. Extend the TTL so the next call within the window is a
        // pure hit again.
        cached.expiresAt = Date.now() + latestTtlMs;
      } else {
        // Changed version_no (or the probe itself failed): the entry is
        // stale. Falling through re-fetches in full and replaces it.
        latestCache.delete(name);
        cached = undefined;
      }
    }

    if (cached && opts.config === undefined) {
      return renderFromCache(cached.body, cached.versionNo, opts);
    }

    token = token ?? (await getAccessToken());
    const rpc = await callGetPrompt(base, apiKey, token, name, opts);

    if (!cached) {
      const row = await fetchPromptByTitle(base, apiKey, token, name).catch(() => undefined);
      if (row) {
        latestCache.set(name, { promptId: row.id, body: row.body, versionNo: rpc.version_no, expiresAt: Date.now() + latestTtlMs });
      }
    }
    return toRendered(rpc);
  }

  return {
    getPrompt(name: string, opts: GetPromptOptions = {}): Promise<RenderedPrompt> {
      return opts.version !== undefined ? getPinned(name, opts, opts.version) : getLatest(name, opts);
    },
    invalidate(name: string): void {
      latestCache.delete(name);
    },
  };
}
