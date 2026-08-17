// Loads and validates broker-policy.json (apps/toolbelt/scripts/
// generate-broker-policy.mjs's output, issue #184) at process startup.
// Fails fast on any problem -- an unreadable file, invalid JSON, or a
// document that fails @hyperbolic/broker-contract's own shape check -- since
// a broker that started up on an unverified policy would be a deny-by-default
// failure masquerading as success, the same reasoning
// generate-broker-policy.mjs's own header comment gives for refusing to emit
// a partial document.

import { readFileSync } from "node:fs";
import { validatePolicyDocument, isKnownCaller, type PolicyDocument, type PolicyEntry } from "@hyperbolic/broker-contract";

export type { PolicyDocument, PolicyEntry };

export function loadPolicy(path: string): PolicyDocument {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`services/broker: failed to read broker policy at "${path}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`services/broker: broker policy at "${path}" is not valid JSON: ${(err as Error).message}`);
  }

  const result = validatePolicyDocument(parsed);
  if (!result.ok) {
    throw new Error(
      `services/broker: broker policy at "${path}" failed contract validation:\n${result.errors.map((e: string) => `  - ${e}`).join("\n")}`,
    );
  }

  return parsed as PolicyDocument;
}

export { isKnownCaller };
