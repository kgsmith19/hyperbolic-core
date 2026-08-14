/**
 * Resolves brain.task.v1's prompt.prompt_org_refs entries to a pinned
 * "name@version" (07 section 7.5: "Prompt references resolved as pinned
 * name at version through getPrompt"). A bare name, or an explicit
 * "name@latest", is resolved through the caller-supplied PromptClient at
 * plan time and rewritten to the exact version_no getPrompt returned -- so
 * the contract journaled for a run stays reproducible even if the prompt's
 * "latest" tag moves later. A ref already pinned to a numeric version
 * ("name@3") passes through unchanged, no network call needed.
 */
import type { PromptClient } from "@hyperbolic/llm";

const PINNED_REF_RE = /^(.+)@(\d+)$/;
const LATEST_REF_RE = /^(.+)@latest$/;

export async function resolvePromptOrgRefs(promptClient: PromptClient, refs: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const ref of refs) {
    if (PINNED_REF_RE.test(ref)) {
      resolved.push(ref);
      continue;
    }
    const latestMatch = ref.match(LATEST_REF_RE);
    const name = latestMatch ? latestMatch[1]! : ref;
    const rendered = await promptClient.getPrompt(name);
    resolved.push(`${name}@${rendered.version}`);
  }
  return resolved;
}
