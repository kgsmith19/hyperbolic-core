Title: FIX(acc): close D-02 coverage debt, D-06..D-09 doc drift, and SEC-01 vault denylist
Type: FIX
Component: Agentic Command Center
Milestone: M1 Platform foundations
Depends on: none
Blocks: m4-08-feat-brain-daemon-state.md

## Problem
Three cheap, independent defect groups remain open against ACC (02-health-audit.md): D-02 (hooks/usage.mjs coverage gap behind temporary covgate floors), D-06..D-09 (README ghost script and purged-doc references, policy.json deleted-ADR citation, runner README stale paths, project.yaml stale ci pointer), and SEC-01 (plaintext vault may accept API keys). Fix register and mechanisms are 05-b-acc.md sections 2 and 3. Closing them in M1 restores honest gates before the Brain builds on the ACC kernel.

## Scope
In scope:
- Missing hooks/usage.mjs tests, then deletion of its three floor-override keys and the migration sentences in the policy.json tests note (ACC-2)
- Doc drift edits per the 05-b fix register rows D-06 through D-09 (ACC-3)
- Vault-import denylist of provider key names plus the _API_KEY suffix pattern, failing the whole import with an error naming Infisical (SEC-01, 05-b section 3)
Out of scope:
- Forgepad (m3-08), loopback token (m2-09), kernel or runner contract changes (frozen per 05-b section 8)

## Acceptance criteria
When the suite and covgate run, the system shall exit 0 with the hooks/usage.mjs override keys removed and no new floor overrides added (ACC-1, ACC-2a, ACC-2b).
When the drift grep runs across the four drifted files, the system shall return zero hits (ACC-3).
When vault-import receives a denylisted key name, the engine shall import nothing and exit non-zero naming Infisical (V-1).

## Verification
cd apps/agentic-command-center && npm test && npm run covgate
grep -c 'hooks/usage.mjs' apps/agentic-command-center/policy.json returns 0
grep -n 'e2e:gui\|SYSTEM-REQUIREMENTS\|DATA-FLOW\|docs/adr\|C:\\\\code\\\\guards' apps/agentic-command-center/README.md apps/agentic-command-center/gui/README.md apps/agentic-command-center/policy.json apps/agentic-command-center/runner/README.md apps/agentic-command-center/runner/runner.mjs apps/agentic-command-center/project.yaml returns nothing
printf 'ANTHROPIC_API_KEY=x\n' | ACC_ROOT=$TMP node apps/agentic-command-center/hooks/engine.mjs vault-import; test $? -ne 0

## Estimated LOC delta
Added: 314  Deleted: 44  Net: +270

## Risk
Low; tests, doc edits, and one fail-closed input filter on an existing path.
