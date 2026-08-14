/**
 * The Brain's LifeOS integration surface (LO-4, 05-e-lifeos.md section 3;
 * 07-brain-architecture.md section 7.12; the frozen contract 7.13's cut
 * line names as a V1 stub: "LifeOS forwarding client (API live, LifeOS-side
 * wiring minimal)").
 *
 * Exactly two lanes, both riding LifeOS's own existing HTTP API rather than
 * a new one:
 *   - Read lane: search / getEntity / getHistory / listTypes. Domain
 *     narrowing happens on the LifeOS side, via which `<domain>:read`
 *     scopes the caller's own agent token carries (kernel/access.py's
 *     `require`) -- this client adds no domain filter of its own; see
 *     `search`'s own doc comment for why `opts.domain` is accepted but not
 *     forwarded.
 *   - Proposal lane: proposeAction, the single write-shaped call, gated on
 *     the LifeOS side by `action-proposals:draft` and never anything
 *     wider (domains/agents/proposals.py's own `propose_action`).
 *
 * No other method exists on this surface (LO-4a) -- approval and rejection
 * are operator-only, in the existing Approvals page, deliberately out of
 * this client's reach.
 *
 * Deliberately not wired into dispatch.ts's task-execution path in this
 * issue: deciding which domains a given Brain task may read and how its
 * own scoped token gets minted per task class is planner/task-contract
 * work with its own future issue, not this client's. This module is the
 * independently testable interface 7.13 names as the V1 stub -- ready for
 * that wiring later with no rework to the contract itself.
 */

export type LifeOsScope = `${string}:read` | "action-proposals:draft";

export interface EntitySummary {
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
  recordedAt: string;
  supersededAt: string | null;
}

export interface EntityDetail {
  entity: EntitySummary;
  types: string[];
  edgesOut: LifeOsEdge[];
  edgesIn: LifeOsEdge[];
}

export interface EventRecord {
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

export interface ActionProposalDraft {
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
}

/** 05-e-lifeos.md section 3's contract, verbatim in shape. LO-4a's own
 * verification bullet ("type-level check that `LifeOsSurface` has exactly
 * 5 methods") is exercised in lifeos-surface.test.ts against this type. */
export interface LifeOsSurface {
  search(query: string, opts?: { domain?: string; limit?: number }): Promise<EntitySummary[]>;
  getEntity(id: string): Promise<EntityDetail>;
  getHistory(id: string): Promise<EventRecord[]>;
  listTypes(): Promise<LifeOsTypeDefinition[]>;
  proposeAction(proposal: ActionProposalDraft): Promise<{ proposalId: string; status: "pending" }>;
}

export interface LifeOsSurfaceConfig {
  /** e.g. `https://lifeos.example.ts.net` -- no trailing slash required. */
  baseUrl: string;
  /** The Brain's self-issued ES256 read/draft-scoped agent token (05-e
   * section 3's "Token minting" paragraph); minted and verified entirely
   * on the LifeOS side. This client only ever attaches it as a bearer
   * credential -- it neither mints nor inspects it. */
  agentToken: string;
}

export class LifeOsRequestError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`services/brain: LifeOS ${method} ${path} failed with status ${status}: ${body}`);
    this.name = "LifeOsRequestError";
    this.status = status;
  }
}

async function call<T>(config: LifeOsSurfaceConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.agentToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new LifeOsRequestError(method, path, res.status, text);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

interface RawEntity {
  id: string;
  name: string | null;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function toEntitySummary(raw: RawEntity): EntitySummary {
  return { id: raw.id, name: raw.name, attributes: raw.attributes, createdAt: raw.created_at, updatedAt: raw.updated_at };
}

interface RawEdge {
  id: string;
  from_entity: string;
  relation: string;
  to_entity: string;
  attributes: Record<string, unknown>;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  superseded_at: string | null;
}

function toEdge(raw: RawEdge): LifeOsEdge {
  return {
    id: raw.id,
    fromEntity: raw.from_entity,
    relation: raw.relation,
    toEntity: raw.to_entity,
    attributes: raw.attributes,
    validFrom: raw.valid_from,
    validTo: raw.valid_to,
    recordedAt: raw.recorded_at,
    supersededAt: raw.superseded_at,
  };
}

interface RawEvent {
  id: string;
  entity_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  valid_time: string;
  recorded_at: string;
  actor: string;
}

function toEventRecord(raw: RawEvent): EventRecord {
  return {
    id: raw.id,
    entityId: raw.entity_id,
    eventType: raw.event_type,
    payload: raw.payload,
    validTime: raw.valid_time,
    recordedAt: raw.recorded_at,
    actor: raw.actor,
  };
}

interface RawTypeDefinition {
  id: string;
  name: string;
  domain: string;
  json_schema: Record<string, unknown>;
  parent_type_id: string | null;
  is_active: boolean;
  created_at: string;
}

function toTypeDefinition(raw: RawTypeDefinition): LifeOsTypeDefinition {
  return {
    id: raw.id,
    name: raw.name,
    domain: raw.domain,
    jsonSchema: raw.json_schema,
    parentTypeId: raw.parent_type_id,
    isActive: raw.is_active,
    createdAt: raw.created_at,
  };
}

interface RawProposalView {
  proposal_id: string;
  state: string;
}

/** Builds the one concrete `LifeOsSurface` this issue ships -- a thin
 * fetch client over LifeOS's already-existing kernel service routes
 * (api/main.py), never a new endpoint. */
export function createLifeOsSurface(config: LifeOsSurfaceConfig): LifeOsSurface {
  return {
    async search(query, opts) {
      // `GET /search`'s only filters are `type_name` (one specific entity
      // type, e.g. "bill") and `text` (free-text). LifeOS has no
      // domain-level filter param -- domains routinely hold several
      // differently-named types (bills: bill/eob/bill_extraction/...), so
      // forwarding `opts.domain` as `type_name` would silently return
      // nothing for any multi-type domain rather than the domain's full
      // set. `opts.domain` is accepted for interface conformance (the
      // caller's own agent token already restricts which domains are
      // readable at all) and intentionally not sent as a query param.
      // `opts.limit` has no server-side equivalent either (`/search`
      // returns its full result set), so it is applied client-side.
      const params = new URLSearchParams({ text: query });
      const rows = await call<RawEntity[]>(config, "GET", `/search?${params.toString()}`);
      const summaries = rows.map(toEntitySummary);
      return opts?.limit !== undefined ? summaries.slice(0, opts.limit) : summaries;
    },

    async getEntity(id) {
      const raw = await call<{ entity: RawEntity; types: string[]; edges_out: RawEdge[]; edges_in: RawEdge[] }>(
        config,
        "GET",
        `/entities/${encodeURIComponent(id)}`
      );
      return {
        entity: toEntitySummary(raw.entity),
        types: raw.types,
        edgesOut: raw.edges_out.map(toEdge),
        edgesIn: raw.edges_in.map(toEdge),
      };
    },

    async getHistory(id) {
      const rows = await call<RawEvent[]>(config, "GET", `/entities/${encodeURIComponent(id)}/history`);
      return rows.map(toEventRecord);
    },

    async listTypes() {
      const rows = await call<RawTypeDefinition[]>(config, "GET", "/types");
      return rows.map(toTypeDefinition);
    },

    async proposeAction(proposal) {
      const raw = await call<RawProposalView>(config, "POST", "/action-proposals", {
        kind: proposal.kind,
        summary: proposal.summary,
        payload: proposal.payload ?? {},
      });
      // `propose_action` is idempotent on (proposer, kind, summary): a
      // retried identical draft resolves to the SAME already-existing
      // record rather than a fresh one, which in principle could already
      // be decided. The frozen return shape (05-e section 3) has no slot
      // for that state, and this surface has no 6th method to fetch it
      // (LO-4a) -- `status` reports the create-intent, "pending", exactly
      // as every freshly proposed draft is; a caller that needs the
      // record's actual current state reads it back via the Approvals
      // listing, not this client.
      return { proposalId: raw.proposal_id, status: "pending" };
    },
  };
}
