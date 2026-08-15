-- PR #8 independent security review, Finding 47 (originally filed P2;
-- revalidated against current HEAD and treated with P1 rigor -- the most
-- serious finding in its batch): platform-client accepts any authenticated
-- Supabase subject, not just the platform owner.
--
-- packages/platform-client/src/types.ts's own PlatformSession doc comment
-- has always said the session subject "Must equal the owner UUID; any other
-- subject is a bug (ADR-03, fail closed)" -- but nothing in
-- packages/platform-client/src/index.ts (signInWithPassword, getSession,
-- onAuthStateChange) or apps/shell/src/lib/auth-gate.ts's
-- computeGateDecision ever compared the resolved subject against the owner.
-- Real data access was never actually open -- platform.owner()-pinned RLS
-- (20260812160000_core_idea_owner_pin.sql) is the genuine server-side
-- boundary, independent of this fix -- so this closes a defense-in-depth/UX
-- gap: a non-owner authenticated caller was reported "signed in" by a client
-- that would then issue every owner-pinned request only to have RLS
-- silently return zero rows, rather than being told plainly they are not
-- the owner.
--
-- platform.owner() (20260812140000_platform_owner_bootstrap.sql) already
-- exists and is exactly the comparison this needs, but `platform` is
-- deliberately NOT exposed via PostgREST (pgrst.db_schemas, set in
-- 20260812150000_test_create_fence.sql, omits it -- "there is no API
-- surface for this schema", by design: the owner UUID itself must never be
-- readable by any client, only comparable against). `core` is already
-- PostgREST-exposed (same pgrst.db_schemas list), so this function lives
-- there and calls platform.owner() internally -- SECURITY DEFINER
-- privileges apply regardless of which schema exposes the wrapper (same
-- pattern core.log_run already uses to reach platform.owner(),
-- 20260812160000_core_idea_owner_pin.sql).
--
-- Deliberately returns a plain boolean, never the owner UUID: "am I the
-- owner" carries no sensitive information for any authenticated caller to
-- learn the answer to (a non-owner learning "no" reveals nothing they don't
-- already know), so EXECUTE is granted to `authenticated` broadly -- unlike
-- platform.owner() itself (never exposed over the API at all) or
-- intake.mark_submitted_to_github() (service_role only; this session's
-- other P1 fix, apps/toolbelt/apps/idea-intake/backend/supabase/migrations/
-- 20260814040000_intake_mark_submitted_to_github_rpc.sql): this RPC's whole
-- purpose IS for any authenticated caller to invoke it and get a truthful
-- answer, safely.
--
-- Both auth.uid() and platform.owner() are wrapped in scalar subqueries
-- ((select ...)) even though only the platform.owner() half is
-- validate-migrations.mjs-enforced (checkOwnerCallWrapping) -- matching
-- 20260812160000's own established convention for every owner comparison in
-- this codebase, and keeping InitPlan caching available should this
-- function's body ever grow into something Postgres would otherwise
-- re-evaluate per row.
create function core.is_platform_owner() returns boolean
language sql
stable
security definer
set search_path = core, platform, pg_temp
as $$ select (select auth.uid()) = (select platform.owner()) $$;

-- Revoke-then-grant, narrowest first (this session's established house
-- style -- see 20260812140000_platform_owner_bootstrap.sql's platform.owner()
-- and 20260814040000_intake_mark_submitted_to_github_rpc.sql):
-- Postgres grants EXECUTE to PUBLIC at CREATE FUNCTION time by default;
-- strip that first so the only path in is the explicit grant below. `anon`
-- is deliberately excluded -- this answers "am I the owner" for an
-- authenticated session, not an anonymous one (an unauthenticated caller
-- has no session for auth.uid() to resolve, so the comparison is always
-- false for them anyway, but there is no reason to expose the RPC to that
-- role at all).
revoke all on function core.is_platform_owner() from public;
grant execute on function core.is_platform_owner() to authenticated;
