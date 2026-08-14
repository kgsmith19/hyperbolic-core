/**
 * brain.task.v1 / brain.result.v1 validation (07-brain-architecture.md
 * section 7.5, m4-09): ajv-compiled validators over the schema files in
 * ./schemas, the same Ajv2020 + ajv-formats setup
 * apps/toolbelt/scripts/validate-manifests.mjs already established for
 * tool.schema.json. The TS interfaces below mirror the schemas' shape for
 * planner/service code to author against; the schema files, not these
 * interfaces, are the source of truth enforced at plan and dispatch time.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// Named/`.default` import forms below, not a plain `import Ajv2020 from
// "ajv/dist/2020.js"` -- under this package's "type": "module" +
// moduleResolution nodenext, TS types a bare default import of these CJS
// packages as the whole CJS exports namespace (matching Node's own actual
// ESM/CJS interop, which binds a default import to `module.exports` as a
// whole), not as the class/function value the .d.ts's own `export default`
// syntax suggests. Ajv2020 is also a NAMED export (`export declare class
// Ajv2020`), so the named form sidesteps the issue entirely; ajv-formats
// has no such named export, so `.default` is accessed explicitly instead
// -- both forms verified against the real compiled .js (module.exports is
// the class/function itself, with a self-referential `.default`), so this
// works identically at runtime and under `tsc -b`.
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { ValidateFunction } from "ajv";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Schemas live under src/schemas/ (not a sibling services/brain/schemas/)
// specifically so the Dockerfile's existing `COPY services/brain/src
// services/brain/src` step (no separate schemas COPY line needed) carries
// them into the production image unchanged.
const TASK_SCHEMA_PATH = join(__dirname, "schemas", "brain.task.v1.schema.json");
const RESULT_SCHEMA_PATH = join(__dirname, "schemas", "brain.result.v1.schema.json");
const EVAL_CASE_SCHEMA_PATH = join(__dirname, "schemas", "brain.eval-case.v1.schema.json");

export interface TaskContractV1 {
  task_id: string;
  run_id: string;
  title: string;
  repo: { url: string; ref: string };
  harness: { preferred: "claude-code" | "codex" | "gemini" | null; fallback: string[] };
  autonomy: number;
  prompt: { objective: string; context_refs: string[]; prompt_org_refs: string[] };
  constraints: {
    allowed_paths: string[];
    denied_paths: string[];
    vault_keys: string[];
    max_turns: number;
    wall_clock_min: number;
    token_budget: number;
    network: "none" | "provider-only" | "open";
  };
  acceptance: Array<{
    id: string;
    statement: string;
    verify: { command: string; cwd: string; expect_exit: number; timeout_s: number };
  }>;
  deliverable: { type: "commit" | "patch" | "report"; branch: string; push: boolean; draft_pr: boolean };
}

export interface ResultContractV1 {
  task_id: string;
  status: "succeeded" | "failed" | "timeout" | "cancelled" | "interrupted";
  verdicts: Array<{ id: string; pass: boolean; exit: number; output_tail: string }>;
  commits: string[];
  branch: string;
  pr_url: string | null;
  cost: { input_tokens: number; output_tokens: number; cache_read_tokens: number; usd_estimate: number | null };
  duration_s: number;
  transcript_ref: string;
  ledger_ref: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function loadSchema(path: string): object {
  return JSON.parse(readFileSync(path, "utf8")) as object;
}

function compileValidator(path: string): ValidateFunction {
  // strict: true (matching validate-manifests.mjs) so an accidental
  // unknown keyword or ambiguous type fails loudly at compile time rather
  // than silently passing everything through.
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormatsModule.default(ajv);
  return ajv.compile(loadSchema(path));
}

/** brain.eval-case.v1 embeds a whole brain.task.v1 by `$ref`, so its Ajv
 * instance needs both schemas registered before the eval-case one is
 * compiled -- the single-schema compileValidator() above cannot resolve
 * that reference on its own. */
function compileEvalCaseValidator(): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormatsModule.default(ajv);
  ajv.addSchema(loadSchema(TASK_SCHEMA_PATH));
  return ajv.compile(loadSchema(EVAL_CASE_SCHEMA_PATH));
}

// Lazily compiled and cached: every real process only ever needs one
// compiled instance of each; tests that construct many short-lived
// validators (one per assertion) don't pay a re-compile cost either, since
// module state is process-wide, not per-call.
let taskValidator: ValidateFunction | undefined;
let resultValidator: ValidateFunction | undefined;
let evalCaseValidator: ValidateFunction | undefined;

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`);
}

export function validateTaskContract(contract: unknown): ValidationResult {
  taskValidator ??= compileValidator(TASK_SCHEMA_PATH);
  const valid = taskValidator(contract) as boolean;
  return { valid, errors: valid ? [] : formatErrors(taskValidator) };
}

export function validateResultContract(result: unknown): ValidationResult {
  resultValidator ??= compileValidator(RESULT_SCHEMA_PATH);
  const valid = resultValidator(result) as boolean;
  return { valid, errors: valid ? [] : formatErrors(resultValidator) };
}

/** m4-19: every corpus case file, and every case `brain eval capture`
 * produces, is validated against brain.eval-case.v1 before it is trusted
 * -- a malformed case must fail the gate loudly rather than being skipped
 * as "not a case". */
export function validateEvalCase(evalCase: unknown): ValidationResult {
  evalCaseValidator ??= compileEvalCaseValidator();
  const valid = evalCaseValidator(evalCase) as boolean;
  return { valid, errors: valid ? [] : formatErrors(evalCaseValidator) };
}
