/**
 * RegistryClient (docs/planning/05-c-toolbelt.md section 4.3, m3-04): the
 * Shell's ONLY window into `core.app`, the Toolbelt registry table. Every
 * type and the `createRegistryClient` signature below are copied close to
 * verbatim from that section -- this is a frozen interface, same posture as
 * ./types.ts's PlatformClient contract.
 *
 * Discovery contract (05-c section 4.3): query `core.app` through PostgREST,
 * filtered by the caller to whatever `RegistryFilter` it passes (the Shell's
 * own /tools page and command palette scope this to
 * `status in ('building','live')` -- see apps/shell/src/lib/registry.ts).
 * This module holds no opinion about WHICH statuses are "discoverable"; it
 * only translates whatever filter it is given into the matching PostgREST
 * querystring. Rows with a non-null `route` vs. rows without is a decision
 * the CALLER makes (again, apps/shell/src/lib/registry.ts's splitByRoute) --
 * this client only fetches and maps rows, never filters or shapes them
 * beyond the caller's own explicit `RegistryFilter`.
 */

export type ToolKind = "ui" | "cli" | "headless" | "hybrid";
export type ToolStatus = "idea" | "building" | "live" | "retired";

export interface RegisteredTool {
  id: string;
  name: string;
  schemaName: string;
  status: ToolStatus;
  kind: ToolKind;
  route: string | null; // Shell route prefix; null for cli/headless
  version: string;
  description: string | null;
  manifestHash: string | null;
  registeredAt: string | null; // ISO timestamptz
}

export interface RegistryFilter {
  status?: ToolStatus[];
  kind?: ToolKind[];
}

export interface RegistryClient {
  listTools(filter?: RegistryFilter): Promise<RegisteredTool[]>;
  getTool(id: string): Promise<RegisteredTool | null>;
}

/**
 * The raw shape of a `core.app` row as PostgREST serializes it (snake_case,
 * verbatim column names -- 20260812230000_core_app_registry_extension.sql /
 * 20260806190000_core_create_schema.sql are the source of truth this is
 * read against).
 */
interface AppRow {
  id: string;
  name: string;
  schema_name: string;
  status: ToolStatus;
  kind: ToolKind;
  route: string | null;
  version: string;
  description: string | null;
  manifest_hash: string | null;
  registered_at: string | null;
}

function toRegisteredTool(row: AppRow): RegisteredTool {
  return {
    id: row.id,
    name: row.name,
    schemaName: row.schema_name,
    status: row.status,
    kind: row.kind,
    route: row.route ?? null,
    version: row.version,
    description: row.description ?? null,
    manifestHash: row.manifest_hash ?? null,
    registeredAt: row.registered_at ?? null,
  };
}

const SELECT_COLUMNS =
  "id,name,schema_name,status,kind,route,version,description,manifest_hash,registered_at";

/**
 * `core.app`'s anon key (public by design: RLS is the real boundary, not
 * secrecy of this value -- same posture as apps/shell/src/lib/session.ts's
 * DEFAULT_SUPABASE_PUBLISHABLE_KEY and apps/toolbelt/config.mjs's
 * SUPABASE_ANON_KEY, both of which hold this exact byte-identical string
 * today). `createRegistryClient`'s signature (05-c section 4.3) is frozen at
 * exactly two parameters -- supabaseUrl and getAccessToken, no third apikey
 * parameter -- so there is no call-site slot to thread a project-specific
 * anon key through even though every existing PostgREST caller in this repo
 * (apps/toolbelt/tests/helpers.mjs's `rest()`, the Prompt Organizer web
 * client) always sends one alongside the session's Authorization bearer
 * token; Supabase's gateway rejects a request with no `apikey` header at all
 * ("No API key found in request") regardless of how valid the bearer token
 * is. Hardcoding the same public default here -- exactly mirroring how
 * session.ts already hardcodes its own default publishable key -- is the
 * documented judgment call that resolves that gap without widening the
 * frozen signature. Flagged here rather than silently assumed.
 */
const DEFAULT_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";

/**
 * Builds the `?select=...&status=in.(...)&kind=in.(...)` querystring for
 * `listTools`. Pure and separately exported for unit testing (this is one of
 * the two places, per this issue's own testing bar, a bug could silently
 * leak a status this table's caller never asked for -- e.g. dropping a
 * requested filter entirely and returning every row unscoped): an empty or
 * absent `status`/`kind` array omits that filter param entirely (PostgREST's
 * own semantics for "no constraint on this column"), never emits an
 * `in.()` with zero members (which PostgREST would read as "matches
 * nothing," the opposite of "unfiltered").
 */
export function buildListToolsParams(filter?: RegistryFilter): URLSearchParams {
  const params = new URLSearchParams();
  params.set("select", SELECT_COLUMNS);
  if (filter?.status && filter.status.length > 0) {
    params.set("status", `in.(${filter.status.join(",")})`);
  }
  if (filter?.kind && filter.kind.length > 0) {
    params.set("kind", `in.(${filter.kind.join(",")})`);
  }
  // Deterministic ordering: not part of 05-c section 4.3's interface, purely
  // an additive querystring param (PostgREST's own `order` filter) so two
  // calls with the same filter always return rows in the same sequence --
  // callers (and this package's own tests) should never have to re-sort.
  params.set("order", "id.asc");
  return params;
}

export function createRegistryClient(
  supabaseUrl: string,
  getAccessToken: () => Promise<string>
): RegistryClient {
  const base = supabaseUrl.replace(/\/+$/, "");

  async function request(params: URLSearchParams): Promise<RegisteredTool[]> {
    // Fail closed before issuing any network request, matching
    // src/index.ts's authedFetch contract: getAccessToken() is the caller's
    // job to reject/throw when there is no active session (see
    // apps/shell/src/lib/session.ts's wiring), and that rejection propagates
    // here untouched rather than reaching `fetch` with no token at all.
    const token = await getAccessToken();
    const res = await fetch(`${base}/rest/v1/app?${params.toString()}`, {
      headers: {
        apikey: DEFAULT_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `registry-client: GET /rest/v1/app failed with ${res.status}${body ? `: ${body}` : ""}`
      );
    }
    const rows = (await res.json()) as AppRow[];
    return rows.map(toRegisteredTool);
  }

  return {
    listTools(filter) {
      return request(buildListToolsParams(filter));
    },

    async getTool(id) {
      const params = new URLSearchParams();
      params.set("select", SELECT_COLUMNS);
      params.set("id", `eq.${id}`);
      params.set("limit", "1");
      const rows = await request(params);
      return rows[0] ?? null;
    },
  };
}
