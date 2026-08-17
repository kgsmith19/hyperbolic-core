// Resolves broker-held credential VALUES from its own process environment
// (Infisical /platform/broker/, issue #186's dark-until-provisioned
// convention -- the same optional-at-boot pattern services/llm-handler's
// own config.ts already uses for LLM_KEYS_*). Never from a caller: a
// proxied request may NAME a vault key it wants injected, but the value
// itself always comes from here.
//
// Deliberately NOT a raw process.env passthrough: loadCredentials only
// extracts vault key names that some caller's manifest actually declares
// in the loaded policy document (apps/toolbelt/scripts/
// generate-broker-policy.mjs's output, issue #184). This is defense in
// depth against the authorization check in proxy.ts ever having a bug --
// even a broken check could only ever hand out a name that was already a
// legitimate, manifest-declared vault key for SOME caller, never an
// unrelated process env var (NODE_ENV, PATH, ... all happen to match the
// same ^[A-Z][A-Z0-9_]*$ shape tool.schema.json constrains vault key names
// to).

import type { PolicyDocument } from "./policy.ts";

export type CredentialMap = Record<string, string>;

export function loadCredentials(env: NodeJS.ProcessEnv, policy: PolicyDocument): CredentialMap {
  const knownNames = new Set<string>();
  for (const entry of Object.values(policy)) {
    for (const name of entry.vaultKeys ?? []) knownNames.add(name);
  }
  const credentials: CredentialMap = {};
  for (const name of knownNames) {
    const value = env[name];
    if (value) credentials[name] = value;
  }
  return credentials;
}
