-- SPEC-0010 AC-001..AC-003 (FR-014). The delete half of CRUD without a real
-- DELETE: archiving flips a display flag, never touches a row or version.
alter table prompt.prompt add column is_active boolean not null default true;
grant update (is_active) on prompt.prompt to authenticated;
