-- Kernel tables are reachable only through kernel services over the direct
-- lifeos_app connection (invariant 7, ADR 008). RLS stays enabled with no
-- policies so the PostgREST roles (anon, authenticated) can never read or
-- write kernel tables even if grants drift; lifeos_app owns the tables and
-- owner access is not subject to RLS. The Supabase linter reports this as
-- INFO "rls_enabled_no_policy" — that is the intended deny-all state.
alter table public.type_definition enable row level security;
alter table public.entity enable row level security;
alter table public.entity_type enable row level security;
alter table public.edge enable row level security;
alter table public.event enable row level security;
alter table public.embedding enable row level security;

-- Pin the trigger function's search_path (Supabase lint 0011).
alter function public.event_append_only() set search_path = '';
