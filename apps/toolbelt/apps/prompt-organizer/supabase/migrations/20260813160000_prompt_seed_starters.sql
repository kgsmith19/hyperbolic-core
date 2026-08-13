-- m4-03-feat-po-injection-rpc (05-d-prompt-organizer.md section 3, PO-4).
-- Seeds one active starter prompt per taxonomy category, as the platform
-- owner, plus the exact `idea-intake/optimize-v1` prompt 05-h-idea-intake.md
-- section 5 hardcodes as a literal consumer contract
-- (OptimizeIdeaRequest.promptName). `intake/optimize/idea` below is section
-- 3's own taxonomy example for the `intake/optimize` category and is a
-- distinct row from `idea-intake/optimize-v1`: the two live under different
-- first path segments ("intake" vs "idea-intake") because 05-h names the
-- real consumer contract with its own product-name prefix, not the
-- generic category example. Both are seeded so the taxonomy-coverage check
-- (one row per of the 8 `05-d` section 3 categories) and 05-h's literal
-- name dependency are satisfied without contradiction.
--
-- Each seed has a migration-owned stable UUID. Uniqueness is scoped to the
-- row owner so an inaccessible legacy fixture row cannot squat an owner's
-- prompt name (20260813151000).
--
-- DB review finding (PR #9 follow-up): an earlier version of this migration
-- tried to reconcile 20260813130000's random-id rows onto these stable ids
-- via `insert ... on conflict (user_id, lower(title)) do nothing`. That can
-- never work: 20260813130000 already owns every one of these titles for
-- this owner, so the conflict always fires and the insert is always a
-- silent 0-row no-op -- the "stable" ids were never actually written, which
-- made both this file's down migration and 20260813130000_down.sql's
-- delete-by-stable-id no-ops too, silently leaving all 9 rows live on a
-- documented rollback. A straight `update ... set id = ...` cannot fix this
-- either: prompt_version/prompt_configuration/prompt_tag's FKs to
-- prompt.prompt(id) are `on delete cascade` but NOT `on update cascade`, so
-- reassigning an existing row's primary key in place violates referential
-- integrity in either statement order.
--
-- Fix: a temporary table holds the seed values once; a DELETE removes only
-- a row that is BOTH owned by the platform owner AND byte-identical (title
-- and body) to the seed content about to be reinserted; a following INSERT
-- reintroduces exactly that content under the stable id -- a true
-- no-semantic-loss swap for the ordinary case (an untouched prior seed
-- row). Matching on body as well as title, not title alone, is what
-- preserves 20260813130000's own tested guarantee: a genuinely personal
-- prompt that merely happens to share a seeded title (proved with a
-- deliberately different body in seed.test.mjs's "a pre-existing title
-- collision survives both seed and rollback untouched") has a body that
-- can never equal the seed text, so the DELETE leaves it alone and the
-- INSERT's closing `on conflict ... do nothing` (restored here) skips
-- re-adding that title, exactly as before.
--
-- DELETE and INSERT are deliberately two separate top-level statements, not
-- one `WITH ... DELETE ... RETURNING ...) INSERT` combined statement:
-- verified interactively that a data-modifying CTE's writes are NOT visible
-- to that same statement's own `ON CONFLICT` check (both read the
-- statement-start snapshot) -- an INSERT...ON CONFLICT chained onto a CTE
-- DELETE that just freed the exact slot it needs still sees the index entry
-- as occupied and silently skips the reinsert, which would make this
-- migration DELETE its own seed rows and never restore them on a second
-- (idempotent) run, strictly worse than the original no-op bug. Two plain
-- sequential statements on the same session (this file's psql/CLI
-- invocation is always one continuous session, autocommit or not) do not
-- have this problem: each statement sees every earlier statement's
-- completed effect. The temp table is session-scoped, not
-- transaction-scoped (deliberately no `ON COMMIT DROP`), because this file
-- is applied as plain sequential autocommitted statements, not wrapped in
-- an explicit transaction -- also verified interactively.
--
-- FORCE ROW LEVEL SECURITY is lifted around the insert and restored
-- immediately after, on both prompt.prompt and prompt.prompt_version.
-- Necessity proven locally, not assumed: prompt.prompt's owner_rw policy
-- (20260812180000) requires auth.uid() = platform.owner(), which is null
-- for the role that runs this migration directly (no PostgREST session, no
-- JWT); FORCE applies that same check to the table owner too, so the
-- insert fails RLS without lifting it. record_version (20260807041000)
-- then writes one row per seeded prompt into prompt.prompt_version, which
-- is force-RLS'd the same way, so both tables need the same wrapper -- the
-- one-time dedup delete in 20260807041000 established exactly this pattern
-- for prompt.prompt alone (no trigger side effect there); this is its
-- two-table extension.
alter table prompt.prompt no force row level security;
alter table prompt.prompt_version no force row level security;

create temporary table po_seed_starters as
select * from (values

('7a6c6f00-0001-4000-8000-000000000001', 'brain/task-contract', $b1$You are the Brain's dispatcher. Produce a single task contract for a coding harness run, in the exact JSON shape below. Do not include any prose outside the JSON.

Context:
- Repository: {{REPO}}
- Objective: {{OBJECTIVE}}
- Constraints: {{CONSTRAINTS}}
<!--OPTIONAL:prior-attempt-->
- Prior attempt summary (why it failed or what it left unfinished): {{PRIOR_ATTEMPT_SUMMARY}}
<!--/OPTIONAL:prior-attempt-->

Emit exactly this JSON shape, with every field populated from the context above (never leave a field as a placeholder):

{
  "repo": "{{REPO}}",
  "objective": "<one sentence, imperative mood>",
  "acceptance_criteria": ["<EARS-format criterion>", "..."],
  "constraints": ["<constraint>", "..."],
  "verification_command": "<a single shell command that proves done-ness>",
  "risk": "low" | "medium" | "high"
}

Rules: acceptance_criteria must be independently machine-verifiable; verification_command must be copy-pasteable and must not depend on interactive input; risk reflects blast radius, not effort.$b1$),

('7a6c6f00-0002-4000-8000-000000000002', 'coding/system/kernel-run', $b2$You are Claude Code, running inside the Agentic Command Center's kernel for {{REPO}}. You operate autonomously against the task contract you were dispatched with; there is no human watching this session in real time.

Ground rules:
- Read the relevant AGENTS.md/CLAUDE.md files before touching a directory you have not worked in this session.
- Make the smallest coherent change that satisfies the task contract's acceptance criteria.
- Run the task contract's verification_command for real before reporting done; never claim a result you did not observe.
- Never invent file paths, APIs, or test output. If something cannot be verified in this environment, say so explicitly.
<!--OPTIONAL:branch-policy-->
- Work on branch {{BRANCH_NAME}}; do not push to {{PROTECTED_BRANCH}} directly.
<!--/OPTIONAL:branch-policy-->

When you finish, report: what changed, every command you ran with real output, and anything you could not verify and why.$b2$),

('7a6c6f00-0003-4000-8000-000000000003', 'coding/review/simplification', $b3$You are running the code_simplification review pass over the diff below for {{REPO}}. Your only job is reuse, simplification, and efficiency; correctness bugs are out of scope for this pass (a separate security_review pass covers those).

Diff under review:
{{DIFF}}

For each finding, report:
- file and line range
- what is duplicated, over-engineered, or doing more work than the task requires
- the smaller/simpler replacement, concretely (not "consider simplifying")

Do not report style-only nitpicks (naming, formatting) unless they actively obscure behavior. Do not report a finding you are not confident is behavior-preserving.$b3$),

('7a6c6f00-0004-4000-8000-000000000004', 'planning/spec/issue-outcome', $b4$Turn the rough outcome below into one GitHub Issue draft for {{REPO}}, following this repository's Issue-first working model.

Rough outcome: {{OUTCOME}}
<!--OPTIONAL:background-->
Background/why now: {{BACKGROUND}}
<!--/OPTIONAL:background-->

Produce:
1. A short, specific title (imperative, no ticket-speak).
2. A Problem section: what is wrong or missing today, in one or two sentences.
3. A Desired outcome section: the world after this ships, in one or two sentences.
4. Acceptance criteria in EARS form ("When <trigger>, the system shall <response>"), each one machine-verifiable.
5. A verification command or manual check per criterion.

Keep it to the smallest coherent slice that is independently shippable; if the rough outcome is really two issues, say so and split it instead of forcing one draft.$b4$),

('7a6c6f00-0005-4000-8000-000000000005', 'intake/optimize/idea', $b5$Sharpen the idea below into a submission-ready form. Do not invent facts not present in the input; where information is missing, note the gap instead of guessing.

Title: {{TITLE}}
Problem: {{PROBLEM}}
Outcome: {{OUTCOME}}

Rewrite as:
- Title: a specific, concrete restatement (no more than 12 words)
- Problem: the concrete pain, one to three sentences, no jargon that hides the actual issue
- Outcome: the observable state once solved, one to two sentences
- Confidence: low, medium, or high, reflecting how much of the above you had to infer versus were given directly$b5$),

('7a6c6f00-0006-4000-8000-000000000006', 'lifeos/chat/system', $b6$You are the LifeOS assistant. You help {{USER_NAME}} manage tasks, notes, and daily planning inside LifeOS. You have access only to the tools LifeOS has wired to this session; never claim to take an action you were not given a tool for.

Behavior:
- Be direct and brief by default; expand only when asked or when the task genuinely needs it.
- When you change data (create/update/delete a task or note), say what changed in one line, not a narrated play-by-play.
- If a request is ambiguous and the ambiguity changes what you would do, ask one clarifying question instead of guessing.
<!--OPTIONAL:timezone-->
- The user's local time zone is {{TIMEZONE}}; interpret and display all times in it.
<!--/OPTIONAL:timezone-->

Never fabricate a task, note, or calendar entry that does not exist in LifeOS's data.$b6$),

('7a6c6f00-0007-4000-8000-000000000007', 'research/deep-dive', $b7$Research {{TOPIC}} and produce a deep-dive summary for {{AUDIENCE}}.

Requirements:
- Lead with the answer: one paragraph stating the most important conclusion before any background.
- Separate what is well-established from what is contested or uncertain; label each claim.
- Cite where each non-obvious claim comes from (source name or document, not just "reports suggest").
- Close with what would change the conclusion (the strongest counter-evidence or open question).
<!--OPTIONAL:depth-->
- Depth requested: {{DEPTH}} (skim / standard / exhaustive). Match length and rigor to this, not beyond it.
<!--/OPTIONAL:depth-->

Do not pad with generic background the audience already has; every sentence should earn its place.$b7$),

('7a6c6f00-0008-4000-8000-000000000008', 'ops/runbooks/deploy-verify', $b8$Run the post-deploy verification for {{SERVICE}} at {{ENVIRONMENT}}, deployed as {{RELEASE_REF}}.

Checklist:
1. Health check: confirm the service's health endpoint returns healthy within {{HEALTH_TIMEOUT_SECONDS}} seconds of deploy completing.
2. Version check: confirm the running version matches {{RELEASE_REF}} exactly (no stale pods/instances still serving the prior release).
3. Smoke path: exercise the single most important user-facing path end to end and confirm it succeeds.
4. Error budget: check the error rate over the last 15 minutes has not regressed versus the pre-deploy baseline.
<!--OPTIONAL:rollback-->
5. If any check fails, roll back to {{PRIOR_RELEASE_REF}} immediately and only then investigate.
<!--/OPTIONAL:rollback-->

Report each checklist item as pass/fail with the evidence you observed, not just a verdict.$b8$),

('7a6c6f00-0009-4000-8000-000000000009', 'idea-intake/optimize-v1', $b9$Optimize the idea below into a submission-ready draft for {{TARGET_REPO}}. Do not invent facts the input does not support; where you had to infer or fill a gap, lower confidence accordingly rather than presenting a guess as fact.

Title: {{TITLE}}
Problem: {{PROBLEM}}
Outcome: {{OUTCOME}}
Notes: {{NOTES}}

Produce exactly this JSON shape and nothing else (no prose outside the JSON):

{
  "title": "<specific, concrete restatement, no more than 12 words>",
  "problem": "<the concrete pain, one to three sentences>",
  "outcome": "<the observable state once solved, one to two sentences>",
  "notes": "<anything worth preserving from Notes that did not fit title/problem/outcome, or an empty string>",
  "confidence": "low" | "medium" | "high"
}

Confidence reflects how much of the draft came directly from the input versus how much you had to infer. A draft built almost entirely from clear input is "high"; a draft where you filled significant gaps is "low".$b9$)

) as s(id, title, body);

delete from prompt.prompt p
using po_seed_starters s
where p.user_id = (select platform.owner())
  and lower(p.title) = lower(s.title)
  and p.body = s.body;

insert into prompt.prompt (id, user_id, title, body)
select s.id::uuid, (select platform.owner()), s.title, s.body
from po_seed_starters s
on conflict (user_id, lower(title)) do nothing;

drop table po_seed_starters;

alter table prompt.prompt force row level security;
alter table prompt.prompt_version force row level security;
