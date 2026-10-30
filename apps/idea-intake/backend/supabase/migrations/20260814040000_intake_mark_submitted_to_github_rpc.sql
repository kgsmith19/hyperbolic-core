-- PR #8 security review, Finding 8 (P1, merge-blocking): an authenticated
-- client can forge a terminal Idea submission.
--
-- 20260813002605_intake_create_schema.sql's `intake.guard_idea_update`
-- trigger only validates state-machine SHAPE (legal status transitions;
-- that the three github_* columns are set only alongside a transition to
-- 'submitted_to_github', via the `submitted_fields_all_or_none` CHECK plus
-- trigger rule 3) -- it never verifies a server actually created a GitHub
-- Issue. That same migration's grant statement gives `authenticated` direct
-- UPDATE on `status`, `github_issue_number`, `github_issue_url`, and
-- `submitted_at` together. A client can therefore submit one UPDATE setting
-- `status = 'submitted_to_github'` plus entirely fabricated
-- `github_issue_number` / `github_issue_url` / `submitted_at` values: the
-- CHECK constraint is satisfied (all fields present together), the trigger
-- is satisfied (the shape is valid), and per II-3 the row is then
-- permanently frozen around fictitious metadata that no real GitHub Issue
-- backs -- and can never be corrected (submitted rows are immutable by
-- design).
--
-- Fix, in two independent layers:
--
-- 1. Narrow the grant. Column-level GRANT/REVOKE cannot express "authenticated
--    may set `status` for every transition except this one", but it does not
--    need to here: `github_issue_number`, `github_issue_url`, and
--    `submitted_at` are never legitimately client-supplied for ANY
--    transition (they are always server/GitHub-derived), so revoking
--    UPDATE on exactly those three columns is sufficient by itself --
--    `status` stays grantable (draft->idea and idea->idea both still need
--    it) but a client can no longer supply the three github_* values in
--    the same statement, and `submitted_fields_all_or_none` then refuses
--    any attempt to reach 'submitted_to_github' with those columns left at
--    their prior (null, for a not-yet-submitted row) values. This is the
--    same column-scoped-grant technique the original migration already
--    used for the INSERT grant (status/idempotency_key/github_* excluded
--    there for the identical reason), just extended to UPDATE.
--
-- 2. Give the transition a real, narrow, privileged path:
--    intake.mark_submitted_to_github(), SECURITY DEFINER, EXECUTE granted
--    only to `service_role`. It performs the exact same UPDATE a client
--    used to be able to fake, but only a server-side caller holding the
--    service-role key (never shipped to a client -- repo-wide invariant,
--    apps/toolbelt/AGENTS.md "Never commit a service-role key") can invoke
--    it. Deliberately does NOT duplicate or re-implement the state-machine
--    rules: the existing `intake.guard_idea_update` BEFORE UPDATE trigger
--    fires unconditionally for every UPDATE regardless of role or
--    SECURITY DEFINER context (triggers are not an RLS/grant-gated
--    mechanism), so II-1's legal-transition check and II-3's immutability
--    check still apply to this RPC's own UPDATE exactly as they do to any
--    other -- e.g. calling this function against a still-'draft' row still
--    raises "II-1: illegal transition draft -> submitted_to_github", and
--    calling it twice against an already-submitted row still raises "II-3:
--    submitted ideas are immutable". Nothing here weakens that trigger.
--
-- Judgment call (no server-side "who submits Ideas to GitHub" component
-- exists yet in this repo -- apps/idea-intake/tools/ only has
-- migrate-forgepad.mjs, a one-time data-migration CLI, not a submission
-- service; apps/idea-intake/web/index.html is a 19-line static stub with no
-- submission logic; idea-intake's own AGENTS.md is still the scaffold TODO
-- stub). tool.json's `networkEgress: ["api.github.com"]` and
-- `llmHandler.access: true` describe a future submission service that does
-- not exist yet. This RPC is that future service's only legitimate
-- caller-shape today: grant EXECUTE to `service_role` only (the
-- conventional Supabase role for a trusted server-side/backend caller,
-- authenticated via the service-role key), not to any per-user identity --
-- a follow-up Issue owns actually building the GitHub-Issue-creation
-- service that will hold that key and call this RPC.
revoke update (github_issue_number, github_issue_url, submitted_at) on intake.idea from authenticated;

create function intake.mark_submitted_to_github(
  p_idea_id uuid,
  p_issue_number integer,
  p_issue_url text
) returns intake.idea
language plpgsql
security definer
set search_path = intake, pg_temp
as $$
declare
  v_row intake.idea;
begin
  update intake.idea
     set status = 'submitted_to_github',
         github_issue_number = p_issue_number,
         github_issue_url = p_issue_url,
         submitted_at = now()
   where id = p_idea_id
   returning * into v_row;

  if v_row.id is null then
    raise exception 'intake.mark_submitted_to_github: idea % not found', p_idea_id;
  end if;

  return v_row;
end;
$$;

revoke all on function intake.mark_submitted_to_github(uuid, integer, text) from public, anon, authenticated;
grant execute on function intake.mark_submitted_to_github(uuid, integer, text) to service_role;
