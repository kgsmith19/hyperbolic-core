/**
 * Log and prompt-assembly scrubber (07-brain-architecture.md section 7.10:
 * "prompt assembly and log emission pass a scrubber (vault key names to
 * placeholders, token-shaped strings masked); belt-and-suspenders on top
 * of the names-only design"). m4-18's own scope.
 *
 * The names-only design (contracts.ts's TaskContractV1.constraints.
 * vault_keys, kernel-contract.ts's allowedActions.vaultKeys) already
 * means no vault key VALUE is structurally reachable from inside the
 * Brain process today -- envForKeys (apps/agentic-command-center/kernel/
 * credentials.mjs) resolves names to values only inside the kernel
 * subprocess, never here. This module is the defense-in-depth layer for
 * everything that design doesn't structurally prevent: an accidental
 * `NAME=value` shaped string reaching a log line, or any other
 * token/API-key-shaped string (the Brain's OWN Anthropic key included --
 * it IS present in this process's env per ADR-05, so a scrubber that only
 * knew about OTHER services' keys would miss the one credential most
 * worth protecting).
 */

/** Matches common API-key/token shapes by their well-known structural
 * PREFIX, the same discriminator real secret scanners (gitleaks, already
 * wired into this repo's own PR gates, M1-10) rely on -- deliberately
 * NOT a generic "long alphanumeric run" catch-all: this codebase's log
 * lines are full of long alphanumeric-plus-hyphen strings that are not
 * secrets (UUIDs -- run_id/task_id/invocation_id, m4-17's own trace-join
 * ids; git commit SHAs; tool.json manifest_hash values), and masking
 * those would both defeat the trace-join feature and hide genuinely
 * useful debugging content, a worse outcome than the narrower coverage
 * a prefix-based match gives up. */
const TOKEN_SHAPED_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic (ADR-05: the Brain's own key)
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-shaped
  /\bgh[pousr]_[A-Za-z0-9_-]{20,}\b/g, // GitHub PAT/OAuth/App/Server/Refresh tokens
  /\bAKIA[0-9A-Z]{12,}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{12,}\b/g, // AWS temporary access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google API key
  /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT (both header and payload segments base64url-encode a JSON object starting with `{"`, which always begins "ey" in base64)
];

const MASK = "***REDACTED***";

/** `NAME=value` or `NAME: value` shaped occurrences of a known vault key
 * NAME get their value collapsed -- the name itself is never secret (it
 * is exactly what contracts/logs are supposed to carry per the
 * names-only design), only what follows an assignment-shaped separator. */
function maskKnownKeyAssignments(text: string, vaultKeyNames: readonly string[]): string {
  let out = text;
  for (const name of vaultKeyNames) {
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\s*[=:]\\s*\\S+`, "g"), `${name}=${MASK}`);
  }
  return out;
}

/** Masks every token-shaped substring in `text`, then collapses any
 * `KNOWN_NAME=value` assignment for the given vault key names. Order
 * matters: the generic pass already catches most real secret values;
 * the name-assignment pass additionally catches a value too short/plain
 * to be caught by shape alone (e.g. a short test fixture value) as long
 * as it is explicitly labeled with a known vault key name. */
export function scrubText(text: string, vaultKeyNames: readonly string[] = []): string {
  let out = text;
  for (const pattern of TOKEN_SHAPED_PATTERNS) {
    out = out.replace(pattern, MASK);
  }
  return maskKnownKeyAssignments(out, vaultKeyNames);
}

/** Recursively scrubs every string value in an arbitrary log/prompt
 * payload (object, array, or scalar) -- the shape `log.ts`'s `fields`
 * bucket and `journal.ts`'s spread `...extra` properties actually take.
 * Non-string values pass through unchanged; object/array structure is
 * preserved so the scrubbed result stays a drop-in replacement. */
export function scrubValue(value: unknown, vaultKeyNames: readonly string[] = []): unknown {
  if (typeof value === "string") return scrubText(value, vaultKeyNames);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, vaultKeyNames));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, vaultKeyNames);
    return out;
  }
  return value;
}
