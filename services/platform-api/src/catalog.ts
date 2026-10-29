// The REST surface (#508): which Postgres-profile tables are exposed, how
// their SQLite columns map back to JSON, and what each principal may do.
// The grants are ported from the platform project's final state: every
// policy was "the platform owner only", and the column grants below narrow
// what the owner may write. service_role kept the grants Postgres gave it.

export type ColumnType = "text" | "int" | "real" | "bool" | "json";
export type Op = "select" | "insert" | "update" | "delete";

export interface Table {
  /** SQLite table name. */
  sqlite: string;
  columns: Record<string, ColumnType>;
  /** Columns filled by the service when an insert omits them. */
  generated?: Partial<Record<string, "uuid" | "owner" | "now">>;
  /** Columns stamped with now() on every update. */
  touch?: string[];
  owner: Op[];
  service: Op[];
  /** When set, the only columns the owner may insert / update (column grants). */
  ownerInsertColumns?: string[];
  ownerUpdateColumns?: string[];
}

const CRUD: Op[] = ["select", "insert", "update", "delete"];
const READ_APPEND: Op[] = ["select", "insert"];

const ts = "text" as const;

export const CATALOG: Record<string, Record<string, Table>> = {
  core: {
    app: {
      sqlite: "core_app",
      columns: { id: ts, name: ts, schema_name: ts, status: ts, created_at: ts, kind: ts, route: ts, version: ts, description: ts, manifest: "json", manifest_hash: ts, registered_at: ts },
      owner: CRUD, service: CRUD,
    },
    run: {
      sqlite: "core_run",
      columns: { id: ts, app_id: ts, kind: ts, ref: ts, started_at: ts, ended_at: ts, status: ts, user_id: ts },
      generated: { id: "uuid", user_id: "owner" },
      owner: CRUD, service: CRUD,
    },
    cost: {
      sqlite: "core_cost",
      columns: { run_id: ts, input_tokens: "int", output_tokens: "int", cache_read_tokens: "int", llm_calls: "int", tool_calls: "int", wall_clock_ms: "int", interventions: "int", usd: "real" },
      owner: CRUD, service: CRUD,
    },
    event: {
      sqlite: "core_event",
      columns: { id: "int", run_id: ts, parent_id: "int", at: ts, kind: ts, name: ts, payload: "json" },
      owner: CRUD, service: CRUD,
    },
    event_monthly_agg: { sqlite: "core_event_monthly_agg", columns: { month: ts, event_count: "int" }, owner: CRUD, service: CRUD },
    intervention: {
      sqlite: "core_intervention",
      columns: { id: ts, run_id: ts, at: ts, decision_type: ts, was_halt: "bool", was_correction: "bool", note: ts },
      generated: { id: "uuid" },
      owner: CRUD, service: CRUD,
    },
    assumption: {
      sqlite: "core_assumption",
      columns: { id: ts, run_id: ts, app_id: ts, statement: ts, why_needed: ts, how_to_verify: ts, blast_radius: ts, status: ts, created_at: ts, resolved_at: ts },
      generated: { id: "uuid" },
      owner: CRUD, service: CRUD,
    },
    broker_call: {
      sqlite: "core_broker_call",
      columns: { id: ts, ts: ts, caller: ts, target_host: ts, cost_usd: "real" },
      generated: { id: "uuid" },
      owner: CRUD, service: CRUD,
    },
    llm_call: {
      sqlite: "core_llm_call",
      columns: { id: ts, ts: ts, caller_app: ts, purpose: ts, run_ref: ts, provider: ts, model: ts, input_tokens: "int", output_tokens: "int", cache_read_tokens: "int", usd_estimate: "real", latency_ms: "int", status: ts, error_class: ts },
      generated: { id: "uuid" },
      owner: CRUD, service: CRUD,
    },
    llm_call_monthly_agg: { sqlite: "core_llm_call_monthly_agg", columns: { month: ts, call_count: "int" }, owner: CRUD, service: CRUD },
    metric_def: {
      sqlite: "core_metric_def",
      columns: { id: ts, name: ts, formula: ts, unit: ts, is_proxy: "bool", gaming_risk: ts, supersedes: ts, created_at: ts, min_value: "real", max_value: "real" },
      owner: CRUD, service: CRUD,
    },
    metric_value: {
      sqlite: "core_metric_value",
      columns: { metric_id: ts, app_id: ts, at: ts, value: "real", window: ts },
      owner: CRUD, service: CRUD,
    },
    outcome: {
      sqlite: "core_outcome",
      columns: { id: ts, app_id: ts, kind: ts, ref: ts, shipped_at: ts, value_note: ts },
      generated: { id: "uuid" },
      owner: CRUD, service: CRUD,
    },
    run_outcome: { sqlite: "core_run_outcome", columns: { run_id: ts, outcome_id: ts }, owner: CRUD, service: CRUD },
  },
  idea: {
    idea: {
      sqlite: "idea_idea",
      columns: { id: ts, name: ts, category: ts, one_liner: ts, problem: ts, status: ts, app_id: ts, project: ts, schema_name: ts, created_at: ts, updated_at: ts },
      touch: ["updated_at"],
      owner: CRUD, service: CRUD,
    },
    dependency: { sqlite: "idea_dependency", columns: { idea_id: ts, depends_on: ts, reason: ts }, owner: CRUD, service: CRUD },
    score: {
      sqlite: "idea_score",
      columns: { id: ts, idea_id: ts, metric_id: ts, value: "real", scored_at: ts, scored_by: ts },
      generated: { id: "uuid" },
      owner: CRUD, service: CRUD,
    },
  },
  intake: {
    idea: {
      sqlite: "intake_idea",
      columns: { id: ts, parent_idea_id: ts, title: ts, problem: ts, outcome: ts, notes: ts, confidence: ts, status: ts, source: ts, target_repo: ts, idempotency_key: ts, github_issue_number: "int", github_issue_url: ts, submitted_at: ts, user_id: ts, created_at: ts, updated_at: ts },
      generated: { id: "uuid", idempotency_key: "uuid", user_id: "owner" },
      touch: ["updated_at"],
      owner: ["select", "insert", "update", "delete"], service: [],
      ownerInsertColumns: ["parent_idea_id", "title", "problem", "target_repo", "confidence", "notes", "outcome", "source"],
      ownerUpdateColumns: ["confidence", "outcome", "status", "notes", "problem", "source", "title", "target_repo", "updated_at"],
    },
    optimization: {
      sqlite: "intake_optimization",
      columns: { id: ts, input_idea_id: ts, output_idea_id: ts, prompt_name: ts, model: ts, handler_run_id: ts, cost_usd: "real", created_at: ts },
      generated: { id: "uuid" },
      owner: READ_APPEND, service: [],
    },
  },
  prompt: {
    prompt: {
      sqlite: "prompt_prompt",
      columns: { id: ts, user_id: ts, title: ts, body: ts, created_at: ts, is_active: "bool" },
      generated: { id: "uuid", user_id: "owner" },
      owner: ["select", "insert", "update"], service: [],
      ownerInsertColumns: ["user_id", "title", "id", "body", "created_at", "is_active"],
      ownerUpdateColumns: ["title", "body", "is_active"],
    },
    prompt_version: {
      sqlite: "prompt_prompt_version",
      columns: { prompt_id: ts, version_no: "int", body: ts, user_id: ts, created_at: ts },
      owner: READ_APPEND, service: [],
    },
    configuration: {
      sqlite: "prompt_configuration",
      columns: { prompt_id: ts, name: ts, values: "json", sections: "json", created_at: ts },
      owner: READ_APPEND, service: [],
    },
    tag: { sqlite: "prompt_tag", columns: { prompt_id: ts, tag: ts }, owner: READ_APPEND, service: [] },
    usage: {
      sqlite: "prompt_usage",
      columns: { id: ts, prompt_id: ts, version_no: "int", config_name: ts, user_id: ts, created_at: ts },
      generated: { id: "uuid", user_id: "owner" },
      owner: READ_APPEND, service: [],
    },
  },
};
