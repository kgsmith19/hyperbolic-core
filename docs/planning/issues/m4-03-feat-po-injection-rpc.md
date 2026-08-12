Title: FEAT(prompt-organizer): get_prompt injection RPC and starter seed
Type: FEAT
Component: Prompt Organizer
Milestone: M4 The Brain
Depends on: m1-08-feat-db-rls-owner-repin.md
Blocks: m4-04-feat-llm-prompt-client.md, m4-09-feat-brain-task-contract.md

## Problem
render_prompt lacks the three things injection needs: version pinning, ad-hoc values, and provenance in the response (05-d-prompt-organizer.md section 1.2). PO-4 requires starter prompts per taxonomy category, including the prompt Idea Intake depends on (05-h section 5) and the Brain's operational prompts (05-d section 3).

## Scope
In scope:
- Migration pair adding the get_prompt RPC per the 05-d section 1.2 contract fragment (pinned versions resolve from prompt_version body; PT404/PT422 taxonomy; security invoker)
- Migration pair seeding at least one active prompt per 05-d section 3 category, conflict-safe, with an exact-title down migration; includes the Idea Intake optimization prompt named in 05-h section 5
Out of scope:
- The TypeScript client and cache (m4-04); render_prompt changes (frozen for compatibility)

## Acceptance criteria
When get_prompt is called with a valid name, the system shall return text, version_no, and rendered_at; unknown names shall raise the PT404 class and missing variables the PT422 class.
When p_version is pinned, the body shall resolve from prompt_version, not prompt.
Starter prompts shall exist for every category in the 05-d section 3 taxonomy (PO-4).
The injection read path shall return within 150 ms p95 from a warm client (PO-2).

## Verification
node --test apps/toolbelt/apps/prompt-organizer/tests/get-prompt.test.mjs (contract, pin, and error-class cases)
node --test apps/toolbelt/apps/prompt-organizer/tests/seed.test.mjs (grouped count per namespace prefix, each of 8 categories >= 1)
node --test apps/toolbelt/apps/prompt-organizer/tests/performance.test.mjs (p95 over 50 rpc/get_prompt calls under 150 ms)

## Estimated LOC delta
Added: 270  Deleted: 0  Net: +270

## Risk
Low; additive RPC beside the untouched render_prompt and a conflict-safe seed.
