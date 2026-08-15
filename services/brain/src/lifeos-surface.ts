/**
 * The Brain's LifeOS integration surface (m4-20, LO-4;
 * docs/planning/05-e-lifeos.md section 3; 07-brain-architecture.md section
 * 7.12). Exactly the five methods that section's `LifeOsSurface` interface
 * names -- a read lane (search/getEntity/getHistory/listTypes) plus a
 * proposal-only write lane (proposeAction) -- implemented against LifeOS's
 * existing HTTP API (apps/lifeos/backend/src/api/main.py's `/search`,
 * `/entities/*`, `/types`, `/action-proposals` routes), authenticated with a
 * pre-minted `mcp_server.tokens.mint`-format agent token
 * (apps/lifeos/backend/src/api/auth.py now accepts that token kind
 * alongside the owner's Supabase JWT -- this file's server-side half).
 *
 * This client never mints a token itself: the private key that signs one
 * never lives in a repo (mcp_server/tokens.py's own header comment), so a
 * token is provisioned at deploy time (`BRAIN_LIFEOS_AGENT_TOKEN`) exactly
 * like every other cross-service credential in config.ts.
 */

export interface LifeOsEntitySummary {
  id: string;
  name: string | null;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOsEdge {
  id: string;
  fromEntity: string;
  relation: string;
  toEntity: string;
  attributes: Record<string, unknown>;
  validFrom: string;
  validTo: string | null;
}

export interface LifeOsEntityDetail {
  entity: LifeOsEntitySummary;
  types: string[];
  edgesOut: LifeOsEdge[];
  edgesIn: LifeOsEdge[];
}

export interface LifeOsEventRecord {
  id: string;
  entityId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  validTime: string;
  recordedAt: string;
  actor: string;
}

export interface LifeOsTypeDefinition {
  id: string;
  name: string;
  domain: string;
  jsonSchema: Record<string, unknown>;
  parentTypeId: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface LifeOsActionProposalDraft {
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface LifeOsProposalResult {
  proposalId: string;
  status: "pending";
}

/** Section 3's contract shape, verbatim: exactly these 5 methods (LO-4a). */
export interface LifeOsSurface {
  search(query: string, opts?: { domain?: string; limit?: number }): Promise<LifeOsEntitySummary[]>;
  getEntity(id: string): Promise<LifeOsEntityDetail>;
  getHistory(id: string): Promise<LifeOsEventRecord[]>;
  listTypes(): Promise<LifeOsTypeDefinition[]>;
  proposeAction(proposal: LifeOsActionProposalDraft): Promise<LifeOsProposalResult>;
}

export interface LifeOsSurfaceConfig {
  /** LifeOS API base URL (e.g. `https://lifeos-prod.taile48c9b.ts.net:8443/life/api`
   * or a bare `http://127.0.0.1:8000` in dev -- whatever `LIFEOS_ROOT_PATH`
   * the deploy uses; this client sends requests to `${apiUrl}${path}` and
   * has no opinion on the prefix). */
  apiUrl: string;
  /** A token minted by `mcp_server.tokens.mint`: read scopes plus,
   * optionally, `action-proposals:draft` (LO-4c forbids anything else). */
  agentToken: string;
}

export class LifeOsSurfaceError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LifeOsSurfaceError";
    this.status = status;
  }
}

// --- Wire shapes (snake_case, matching kernel/models.py's Pydantic field
// names exactly) -> the camelCase types above. ---------------------------

interface WireEntity {
  id: string;
  name: string | null;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface WireEdge {
  id: string;
  from_entity: string;
  relation: string;
  to_entity: string;
  attributes: Record<string, unknown>;
  valid_from: string;
  valid_to: string | null;
}

interface WireEntityView {
  entity: WireEntity;
  types: string[];
  edges_out: WireEdge[];
  edges_in: WireEdge[];
}

interface WireEvent {
  id: string;
  entity_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  valid_time: string;
  recorded_at: string;
  actor: string;
}

interface WireTypeDefinition {
  id: string;
  name: string;
  domain: string;
  json_schema: Record<string, unknown>;
  parent_type_id: string | null;
  is_active: boolean;
  created_at: string;
}

interface WireProposalView {
  proposal_id: string;
  state: string;
}

function toEntitySummary(e: WireEntity): LifeOsEntitySummary {
  return { id: e.id, name: e.name, attributes: e.attributes, createdAt: e.created_at, updatedAt: e.updated_at };
}

function toEdge(e: WireEdge): LifeOsEdge {
  return { id: e.id, fromEntity: e.from_entity, relation: e.relation, toEntity: e.to_entity, attributes: e.attributes, validFrom: e.valid_from, validTo: e.valid_to };
}

function toEventRecord(e: WireEvent): LifeOsEventRecord {
  return { id: e.id, entityId: e.entity_id, eventType: e.event_type, payload: e.payload, validTime: e.valid_time, recordedAt: e.recorded_at, actor: e.actor };
}

function toTypeDefinition(t: WireTypeDefinition): LifeOsTypeDefinition {
  return { id: t.id, name: t.name, domain: t.domain, jsonSchema: t.json_schema, parentTypeId: t.parent_type_id, isActive: t.is_active, createdAt: t.created_at };
}

// PROPOSED is the only state a fresh `proposeAction` call can observe: the
// proposal lane never creates anything else, and `propose_action`'s own
// idempotent-replay path (domains/agents/proposals.py) returns an existing
// record untouched only when its key already matched -- a caller proposing
// the *same* kind+summary twice in a row, which stays "proposed" until a
// human decides it. A DECIDED state reaching here means some other caller
// already resolved that exact proposal; surfaced as an error rather than a
// dishonest `status: "pending"`, since the interface's return type promises
// exactly that literal.
const PROPOSED_STATE = "proposed";

export function createLifeOsSurface(config: LifeOsSurfaceConfig): LifeOsSurface {
  const base = config.apiUrl.replace(/\/+$/, "");

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.agentToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text;
      try {
        detail = (JSON.parse(text) as { detail?: string }).detail ?? text;
      } catch {
        // Non-JSON body: use the raw text as-is.
      }
      throw new LifeOsSurfaceError(`lifeos-surface: ${method} ${path} failed with ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
    return (await res.json()) as T;
  }

  async function searchOneType(text: string, typeName: string | undefined, limit: number | undefined): Promise<WireEntity[]> {
    const params = new URLSearchParams();
    params.set("text", text);
    if (typeName) params.set("type_name", typeName);
    const results = await call<WireEntity[]>("GET", `/search?${params.toString()}`);
    return limit !== undefined ? results.slice(0, limit) : results;
  }

  return {
    async search(query, opts) {
      if (!opts?.domain) {
        return (await searchOneType(query, undefined, opts?.limit)).map(toEntitySummary);
      }
      // `/search` has no domain filter (kernel find() filters by type_name,
      // never by the domain a type belongs to) -- so a domain-scoped search
      // fans out to one call per type in that domain and merges, rather
      // than silently dropping the caller's `domain` option.
      const types = await call<WireTypeDefinition[]>("GET", "/types");
      const typeNames = types.filter((t) => t.domain === opts.domain).map((t) => t.name);
      const perType = await Promise.all(typeNames.map((name) => searchOneType(query, name, undefined)));
      const merged = new Map<string, WireEntity>();
      for (const entity of perType.flat()) merged.set(entity.id, entity);
      const all = [...merged.values()];
      return (opts.limit !== undefined ? all.slice(0, opts.limit) : all).map(toEntitySummary);
    },

    async getEntity(id) {
      const view = await call<WireEntityView>("GET", `/entities/${encodeURIComponent(id)}`);
      return { entity: toEntitySummary(view.entity), types: view.types, edgesOut: view.edges_out.map(toEdge), edgesIn: view.edges_in.map(toEdge) };
    },

    async getHistory(id) {
      const events = await call<WireEvent[]>("GET", `/entities/${encodeURIComponent(id)}/history`);
      return events.map(toEventRecord);
    },

    async listTypes() {
      const types = await call<WireTypeDefinition[]>("GET", "/types");
      return types.map(toTypeDefinition);
    },

    async proposeAction(proposal) {
      const view = await call<WireProposalView>("POST", "/action-proposals", { kind: proposal.kind, summary: proposal.summary, payload: proposal.payload });
      if (view.state !== PROPOSED_STATE) {
        throw new LifeOsSurfaceError(`lifeos-surface: proposeAction expected a pending proposal but got state ${JSON.stringify(view.state)} for an existing proposal with the same kind+summary (proposal ${view.proposal_id})`);
      }
      return { proposalId: view.proposal_id, status: "pending" };
    },
  };
}
