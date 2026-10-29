// The RPCs the clients call (#508), ported from the platform project's
// plpgsql: same arguments, same authorization, same error codes
// (PT404 not found, PT422 bad input, 42501 not authorized).

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Principal } from "./auth.ts";
import { ApiError, fromRow } from "./rest.ts";
import { CATALOG } from "./catalog.ts";

type Args = Record<string, unknown>;
type Rpc = (db: DatabaseSync, principal: Principal | null, args: Args, ownerId: string) => unknown;

const now = () => new Date().toISOString();

function requireOwner(principal: Principal | null): void {
  if (!principal?.isOwner) throw new ApiError(principal ? 403 : 401, "42501", "owner only");
}
function requireService(principal: Principal | null): void {
  if (!principal?.isService) throw new ApiError(principal ? 403 : 401, "42501", "service_role only");
}
function str(args: Args, name: string, { optional = false } = {}): string | null {
  const value = args[name];
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new ApiError(400, "PT422", `${name} is required`);
  }
  if (typeof value !== "string") throw new ApiError(400, "PT422", `${name} must be a string`);
  return value;
}
function num(args: Args, name: string, { optional = true, integer = false } = {}): number | null {
  const value = args[name];
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new ApiError(400, "PT422", `${name} is required`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new ApiError(400, "PT422", `${name} must be a${integer ? "n integer" : " number"}`);
  }
  return value;
}

/** True for the owner, or a scoped non-interactive agent token holding prompt:get. */
function canReadPrompts(principal: Principal | null): boolean {
  if (principal?.isOwner) return true;
  const scopes = String(principal?.claims.scope ?? "").trim().split(/\s+/);
  return principal?.claims.role === "prompt_get_agent" && scopes.includes("prompt:get");
}

interface Resolved {
  promptId: string;
  body: string;
  versionNo: number;
}

/** Name (case-insensitive) and optional version pin to a body, as get_prompt resolved it. */
function resolvePrompt(db: DatabaseSync, ownerId: string, name: string, version: number | null): Resolved {
  const prompt = db
    .prepare("select id, body, is_active from prompt_prompt where lower(title) = lower(?) and user_id = ?")
    .get(name, ownerId) as { id: string; body: string; is_active: number } | undefined;
  if (!prompt) throw new ApiError(404, "PT404", "prompt not found");
  if (version !== null) {
    const pinned = db
      .prepare("select body from prompt_prompt_version where prompt_id = ? and version_no = ? and user_id = ?")
      .get(prompt.id, version, ownerId) as { body: string } | undefined;
    if (!pinned) throw new ApiError(404, "PT404", "prompt version not found");
    return { promptId: prompt.id, body: pinned.body, versionNo: version };
  }
  // A latest lookup against an archived prompt is a 404: there is no active latest.
  if (!prompt.is_active) throw new ApiError(404, "PT404", "prompt not found");
  const latest = db
    .prepare("select coalesce(max(version_no), 1) as v from prompt_prompt_version where prompt_id = ? and user_id = ?")
    .get(prompt.id, ownerId) as { v: number };
  return { promptId: prompt.id, body: prompt.body, versionNo: Number(latest.v) };
}

/** jsonb key order: shorter keys first, then bytewise. Substitution follows it, as the original's loop did. */
function jsonbKeyOrder(keys: string[]): string[] {
  return [...keys].sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Sections, then variables, then the missing-variable refusal: render_prompt's order. */
export function render(body: string, values: Record<string, string>, sections: string[]): string {
  let text = body;
  const ids = new Set([...text.matchAll(/<!--OPTIONAL:([A-Za-z0-9_-]+)-->/g)].map((match) => match[1] as string));
  for (const id of ids) {
    if (sections.includes(id)) {
      text = text.replaceAll(`<!--OPTIONAL:${id}-->`, "").replaceAll(`<!--/OPTIONAL:${id}-->`, "");
    } else {
      text = text.replace(new RegExp(`<!--OPTIONAL:${escape(id)}-->[\\s\\S]*?<!--/OPTIONAL:${escape(id)}-->`, "g"), "");
    }
  }
  for (const key of jsonbKeyOrder(Object.keys(values))) {
    text = text.replaceAll(`{{${key}}}`, values[key] as string);
  }
  const missing = [...new Set([...text.matchAll(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g)].map((match) => match[1] as string))].sort();
  if (missing.length) throw new ApiError(400, "PT422", `missing variables: ${missing.join(", ")}`);
  return text;
}

function stringMap(value: unknown, name: string): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "PT422", `${name} must be an object of string values`);
  for (const item of Object.values(value)) {
    if (typeof item !== "string") throw new ApiError(400, "PT422", `${name} must contain only string values`);
  }
  return value as Record<string, string>;
}

const RPCS: Record<string, Record<string, Rpc>> = {
  core: {
    is_platform_owner: (_db, principal) => principal?.isOwner === true,
    log_run: (db, principal, args, ownerId) => {
      if (!principal?.isService) requireOwner(principal);
      const id = randomUUID();
      db.exec("begin immediate");
      try {
        db.prepare("insert into core_run (id, app_id, kind, ref, status, ended_at, user_id) values (?, ?, ?, ?, 'ok', ?, ?)").run(
          id, str(args, "p_app_id"), str(args, "p_kind"), str(args, "p_ref", { optional: true }), now(), ownerId,
        );
        db.prepare("insert into core_cost (run_id, input_tokens, output_tokens, cache_read_tokens, wall_clock_ms, usd) values (?, ?, ?, ?, ?, ?)").run(
          id, num(args, "p_input_tokens") ?? 0, num(args, "p_output_tokens") ?? 0, num(args, "p_cache_read_tokens") ?? 0,
          num(args, "p_wall_clock_ms", { optional: false }), num(args, "p_usd") ?? 0,
        );
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return id;
    },
    log_llm_call: (db, principal, args) => {
      requireOwner(principal);
      const id = randomUUID();
      db.prepare(
        `insert into core_llm_call (id, caller_app, purpose, run_ref, provider, model, input_tokens, output_tokens,
          cache_read_tokens, usd_estimate, latency_ms, status, error_class) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, str(args, "p_caller_app"), str(args, "p_purpose"), str(args, "p_run_ref", { optional: true }), str(args, "p_provider"),
        str(args, "p_model"), num(args, "p_input_tokens") ?? 0, num(args, "p_output_tokens") ?? 0, num(args, "p_cache_read_tokens") ?? 0,
        num(args, "p_usd_estimate"), num(args, "p_latency_ms"), str(args, "p_status"), str(args, "p_error_class", { optional: true }),
      );
      return id;
    },
    log_broker_call: (db, principal, args) => {
      requireService(principal);
      const id = randomUUID();
      db.prepare("insert into core_broker_call (id, caller, target_host, cost_usd) values (?, ?, ?, ?)").run(
        id, str(args, "p_caller"), str(args, "p_target_host"), num(args, "p_cost_usd", { optional: false }),
      );
      return id;
    },
    broker_call_spend_today: (db, principal, args) => {
      requireService(principal);
      const startOfDay = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
      const row = db.prepare("select coalesce(sum(cost_usd), 0) as total from core_broker_call where caller = ? and ts >= ?").get(
        str(args, "p_caller"), startOfDay,
      ) as { total: number };
      return Number(row.total);
    },
  },
  platform: {
    owner: (_db, _principal, _args, ownerId) => ownerId,
  },
  prompt: {
    get_prompt: (db, principal, args, ownerId) => {
      if (!canReadPrompts(principal)) throw new ApiError(principal ? 403 : 401, "42501", "get_prompt is not authorized for this principal");
      const values = stringMap(args.p_values, "p_values");
      const resolved = resolvePrompt(db, ownerId, str(args, "p_name") as string, num(args, "p_version", { integer: true }));
      let configValues: Record<string, string> = {};
      let sections: string[] = [];
      const config = str(args, "p_config", { optional: true });
      if (config !== null) {
        const row = db.prepare('select "values", sections from prompt_configuration where prompt_id = ? and name = ?').get(resolved.promptId, config) as
          | { values: string; sections: string }
          | undefined;
        if (!row) throw new ApiError(404, "PT404", "configuration not found");
        configValues = JSON.parse(row.values) as Record<string, string>;
        sections = JSON.parse(row.sections) as string[];
      }
      if (args.p_sections !== undefined && args.p_sections !== null) {
        if (!Array.isArray(args.p_sections) || args.p_sections.some((s) => typeof s !== "string")) {
          throw new ApiError(400, "PT422", "p_sections must be an array of strings");
        }
        sections = args.p_sections as string[];
      }
      const text = render(resolved.body, { ...configValues, ...values }, sections);
      return { text, version_no: resolved.versionNo, rendered_at: now() };
    },
    get_prompt_source: (db, principal, args, ownerId) => {
      if (!canReadPrompts(principal)) throw new ApiError(principal ? 403 : 401, "42501", "get_prompt_source is not authorized for this principal");
      const resolved = resolvePrompt(db, ownerId, str(args, "p_name") as string, num(args, "p_version", { integer: true }));
      const ifVersion = num(args, "p_if_version", { integer: true });
      if (ifVersion !== null && ifVersion === resolved.versionNo) {
        return { body: null, version_no: resolved.versionNo, not_modified: true };
      }
      return { body: resolved.body, version_no: resolved.versionNo, not_modified: false };
    },
  },
  intake: {
    mark_submitted_to_github: (db, principal, args) => {
      requireService(principal);
      const issueNumber = num(args, "p_issue_number", { optional: false, integer: true });
      let row: Record<string, unknown> | undefined;
      try {
        row = db
          .prepare(
            `update intake_idea set status = 'submitted_to_github', github_issue_number = ?, github_issue_url = ?,
               submitted_at = ?, updated_at = ? where id = ? returning *`,
          )
          .get(issueNumber, str(args, "p_issue_url"), now(), now(), str(args, "p_idea_id")) as Record<string, unknown> | undefined;
      } catch (error) {
        throw new ApiError(400, "23514", error instanceof Error ? error.message : String(error));
      }
      if (!row) throw new ApiError(400, "P0001", `intake.mark_submitted_to_github: idea ${String(args.p_idea_id)} not found`);
      const table = CATALOG.intake?.idea;
      return table ? fromRow(table, row, Object.keys(table.columns)) : row;
    },
  },
};

export function handleRpc(db: DatabaseSync, principal: Principal | null, ownerId: string, profile: string | null, name: string, body: unknown): unknown {
  const fn = RPCS[profile ?? "core"]?.[name];
  if (!fn) throw new ApiError(404, "PGRST202", `Could not find the function ${profile ?? "core"}.${name} in the schema cache`);
  const args = body === null || body === undefined ? {} : body;
  if (typeof args !== "object" || Array.isArray(args)) throw new ApiError(400, "PGRST102", "RPC arguments must be one JSON object");
  return fn(db, principal, args as Args, ownerId);
}
