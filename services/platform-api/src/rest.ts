// The PostgREST subset the clients use (#508): GET/POST/PATCH/DELETE on
// /rest/v1/<table> with Accept-Profile/Content-Profile, `select` column lists,
// eq/neq/gt/gte/lt/lte/like/ilike/in/is filters, `order`, `limit`, `offset`
// and Prefer return=representation|minimal. Anything outside the subset is a
// 400, never a silently different query.

import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { Principal } from "./auth.ts";
import { CATALOG, type ColumnType, type Op, type Table } from "./catalog.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const now = () => new Date().toISOString();
const IDENT = /^[a-z_][a-z0-9_]*$/;
const RESERVED = new Set(["select", "order", "limit", "offset"]);
const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "like", ilike: "like" };

export function resolveTable(profile: string | null, name: string): Table {
  const schema = CATALOG[profile ?? "core"];
  const table = schema?.[name];
  if (!table) throw new ApiError(404, "PGRST205", `Could not find the table '${profile ?? "core"}.${name}' in the schema cache`);
  return table;
}

export function authorize(table: Table, op: Op, principal: Principal | null): "owner" | "service" {
  if (principal?.isOwner && table.owner.includes(op)) return "owner";
  if (principal?.isService && table.service.includes(op)) return "service";
  if (!principal) throw new ApiError(401, "PGRST301", "a signed-in owner or a service token is required");
  throw new ApiError(403, "42501", `permission denied: ${op} on this table`);
}

function toSql(type: ColumnType, value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "json":
      return JSON.stringify(value);
    case "bool":
      if (typeof value !== "boolean") throw new ApiError(400, "22P02", `expected a boolean, got ${JSON.stringify(value)}`);
      return value ? 1 : 0;
    case "int":
    case "real":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiError(400, "22P02", `expected a number, got ${JSON.stringify(value)}`);
      return value;
    default:
      if (typeof value !== "string") throw new ApiError(400, "22P02", `expected a string, got ${JSON.stringify(value)}`);
      return value;
  }
}

function filterValue(type: ColumnType, raw: string): SQLInputValue {
  if (type === "bool") {
    if (raw === "true" || raw === "false") return raw === "true" ? 1 : 0;
    throw new ApiError(400, "22P02", `invalid boolean: ${raw}`);
  }
  if (type === "int" || type === "real") {
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) throw new ApiError(400, "22P02", `invalid number: ${raw}`);
    return n;
  }
  return raw;
}

export function fromRow(table: Table, row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    const value = row[column];
    const type = table.columns[column];
    if (value === null || value === undefined) out[column] = null;
    else if (type === "json") out[column] = JSON.parse(String(value));
    else if (type === "bool") out[column] = value === 1 || value === 1n;
    else if (typeof value === "bigint") out[column] = Number(value);
    else out[column] = value;
  }
  return out;
}

function column(table: Table, name: string): string {
  if (!IDENT.test(name) || !(name in table.columns)) throw new ApiError(400, "42703", `column '${name}' does not exist`);
  return name;
}

const quote = (name: string) => `"${name}"`;

export function selectedColumns(table: Table, select: string | null): string[] {
  if (select === null || select.trim() === "*") return Object.keys(table.columns);
  return select.split(",").map((part) => {
    const name = part.trim();
    if (name.includes("(") || name.includes(":")) throw new ApiError(400, "PGRST100", "embedding and aliases are not supported by the local platform");
    return column(table, name);
  });
}

export function whereClause(table: Table, params: URLSearchParams): { sql: string; args: SQLInputValue[] } {
  const parts: string[] = [];
  const args: SQLInputValue[] = [];
  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue;
    const name = column(table, key);
    const type = table.columns[name] as ColumnType;
    const dot = raw.indexOf(".");
    if (dot < 0) throw new ApiError(400, "PGRST100", `filter '${key}=${raw}' needs an operator`);
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (op === "is") {
      if (value === "null") parts.push(`${quote(name)} is null`);
      else if (value === "true" || value === "false") {
        parts.push(`${quote(name)} = ?`);
        args.push(value === "true" ? 1 : 0);
      } else throw new ApiError(400, "PGRST100", `is.${value} is not supported`);
    } else if (op === "in") {
      const match = /^\((.*)\)$/.exec(value);
      if (!match) throw new ApiError(400, "PGRST100", `in.${value} must be a parenthesized list`);
      const items = match[1] === "" ? [] : (match[1] as string).split(",").map((item) => item.trim().replace(/^"(.*)"$/, "$1"));
      if (items.length === 0) parts.push("0");
      else {
        parts.push(`${quote(name)} in (${items.map(() => "?").join(", ")})`);
        args.push(...items.map((item) => filterValue(type, item)));
      }
    } else if (op in OPS) {
      const sqlOp = OPS[op] as string;
      if (op === "like" || op === "ilike") {
        parts.push(op === "ilike" ? `lower(${quote(name)}) like lower(?)` : `${quote(name)} like ?`);
        args.push(value.replaceAll("*", "%"));
      } else {
        parts.push(`${quote(name)} ${sqlOp} ?`);
        args.push(filterValue(type, value));
      }
    } else {
      throw new ApiError(400, "PGRST100", `operator '${op}' is not supported by the local platform`);
    }
  }
  return { sql: parts.length ? ` where ${parts.join(" and ")}` : "", args };
}

function orderClause(table: Table, order: string | null): string {
  if (!order) return "";
  const terms = order.split(",").map((term) => {
    const [name = "", direction = "asc", nulls] = term.trim().split(".");
    if (direction !== "asc" && direction !== "desc") throw new ApiError(400, "PGRST100", `bad order direction: ${direction}`);
    if (nulls !== undefined && nulls !== "nullsfirst" && nulls !== "nullslast") throw new ApiError(400, "PGRST100", `bad order nulls: ${nulls}`);
    return `${quote(column(table, name))} ${direction}${nulls ? ` nulls ${nulls.slice(5)}` : ""}`;
  });
  return ` order by ${terms.join(", ")}`;
}

function pageClause(params: URLSearchParams): string {
  const parse = (key: string) => {
    const raw = params.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new ApiError(400, "PGRST100", `${key} must be a non-negative integer`);
    return n;
  };
  const limit = parse("limit");
  const offset = parse("offset");
  return `${limit !== null ? ` limit ${limit}` : offset !== null ? " limit -1" : ""}${offset !== null ? ` offset ${offset}` : ""}`;
}

function constraintError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/.test(message)) throw new ApiError(409, "23505", message);
  if (/FOREIGN KEY constraint failed/.test(message)) throw new ApiError(409, "23503", message);
  if (/NOT NULL constraint failed/.test(message)) throw new ApiError(400, "23502", message);
  if (/CHECK constraint failed|II-[13]:|value is (below|above)/.test(message)) throw new ApiError(400, "23514", message);
  throw error;
}

export interface RestRequest {
  method: string;
  profile: string | null;
  table: string;
  params: URLSearchParams;
  body: unknown;
  prefer: string;
}

export function handleRest(db: DatabaseSync, principal: Principal | null, ownerId: string, req: RestRequest): { status: number; body: unknown } {
  const table = resolveTable(req.profile, req.table);
  const returnRows = /return=representation/.test(req.prefer);
  const columns = selectedColumns(table, req.params.get("select"));
  const project = (rows: Record<string, unknown>[]) => rows.map((row) => fromRow(table, row, columns));

  if (req.method === "GET" || req.method === "HEAD") {
    authorize(table, "select", principal);
    const where = whereClause(table, req.params);
    const rows = db
      .prepare(`select ${columns.map(quote).join(", ")} from ${table.sqlite}${where.sql}${orderClause(table, req.params.get("order"))}${pageClause(req.params)}`)
      .all(...where.args) as Record<string, unknown>[];
    return { status: 200, body: project(rows) };
  }

  if (req.method === "POST") {
    const role = authorize(table, "insert", principal);
    const items = Array.isArray(req.body) ? req.body : [req.body];
    if (items.length === 0 || items.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
      throw new ApiError(400, "PGRST102", "the body must be an object or a non-empty array of objects");
    }
    const inserted: Record<string, unknown>[] = [];
    db.exec("begin immediate");
    try {
      for (const item of items as Record<string, unknown>[]) {
        const values: Record<string, unknown> = { ...item };
        for (const key of Object.keys(values)) {
          column(table, key);
          if (role === "owner" && table.ownerInsertColumns && !table.ownerInsertColumns.includes(key)) {
            throw new ApiError(403, "42501", `permission denied to insert column '${key}'`);
          }
        }
        for (const [key, kind] of Object.entries(table.generated ?? {})) {
          if (kind === "owner") {
            if (values[key] !== undefined && values[key] !== ownerId) throw new ApiError(403, "42501", `${key} must be the platform owner`);
            values[key] = ownerId;
          } else if (values[key] === undefined) {
            values[key] = kind === "uuid" ? randomUUID() : now();
          }
        }
        const keys = Object.keys(values);
        const row = db
          .prepare(`insert into ${table.sqlite} (${keys.map(quote).join(", ")}) values (${keys.map(() => "?").join(", ")}) returning *`)
          .get(...keys.map((key) => toSql(table.columns[key] as ColumnType, values[key]))) as Record<string, unknown>;
        inserted.push(row);
      }
      db.exec("commit");
    } catch (error) {
      db.exec("rollback");
      if (error instanceof ApiError) throw error;
      constraintError(error);
    }
    return { status: 201, body: returnRows ? project(inserted) : null };
  }

  if (req.method === "PATCH") {
    const role = authorize(table, "update", principal);
    if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
      throw new ApiError(400, "PGRST102", "the body must be one object");
    }
    const values: Record<string, unknown> = { ...(req.body as Record<string, unknown>) };
    for (const key of Object.keys(values)) {
      column(table, key);
      if (role === "owner" && table.ownerUpdateColumns && !table.ownerUpdateColumns.includes(key)) {
        throw new ApiError(403, "42501", `permission denied to update column '${key}'`);
      }
    }
    for (const key of table.touch ?? []) values[key] = now();
    const where = whereClause(table, req.params);
    if (!where.sql) throw new ApiError(400, "21000", "UPDATE requires a WHERE clause");
    const keys = Object.keys(values);
    if (keys.length === 0) throw new ApiError(400, "PGRST102", "nothing to update");
    let rows: Record<string, unknown>[] = [];
    try {
      rows = db
        .prepare(`update ${table.sqlite} set ${keys.map((key) => `${quote(key)} = ?`).join(", ")}${where.sql} returning *`)
        .all(...keys.map((key) => toSql(table.columns[key] as ColumnType, values[key])), ...where.args) as Record<string, unknown>[];
    } catch (error) {
      constraintError(error);
    }
    return { status: returnRows ? 200 : 204, body: returnRows ? project(rows) : null };
  }

  if (req.method === "DELETE") {
    authorize(table, "delete", principal);
    const where = whereClause(table, req.params);
    if (!where.sql) throw new ApiError(400, "21000", "DELETE requires a WHERE clause");
    let rows: Record<string, unknown>[] = [];
    try {
      rows = db.prepare(`delete from ${table.sqlite}${where.sql} returning *`).all(...where.args) as Record<string, unknown>[];
    } catch (error) {
      constraintError(error);
    }
    return { status: returnRows ? 200 : 204, body: returnRows ? project(rows) : null };
  }

  throw new ApiError(405, "PGRST117", `method ${req.method} is not supported`);
}
