-- Extends core.app for the tool.json manifest contract (m3-01) to register
-- against. DDL applied verbatim from docs/planning/05-c-toolbelt.md section
-- 4.1, which cites the pre-extension shape at
-- 20260806190000_core_create_schema.sql lines 12-19 (id, name, schema_name,
-- status, created_at only).
alter table core.app
  add column kind          text not null default 'ui'
             check (kind in ('ui','cli','headless','hybrid')),
  add column route         text,
  add column version       text not null default '0.0.0',
  add column description   text,
  add column manifest      jsonb,
  add column manifest_hash text,
  add column registered_at timestamptz;

comment on column core.app.manifest is
  'Verbatim tool.json at registration time; the file in the repo is authoritative, this copy serves discovery.';

-- 05-c section 4.1: "Existing rows need one data migration line setting
-- kind/route for prompt-organizer (the single registered app
-- [20260807040000_register_prompt_organizer.sql])." This is that one line:
-- an idempotent UPDATE against the row that migration already inserted, not
-- a blind INSERT (the row must not be deleted or recreated here).
-- kind='ui': Prompt Organizer is a browser client served from web/, not a
-- CLI or headless process (05-d-prompt-organizer.md section 0: "the web
-- client signs in, saves, tags, searches, renders with variables...").
-- route='/prompts' names the Shell route prefix this tool will claim once
-- Shell integration lands (tracked separately: m3-04, m5-01); assigning it
-- now follows section 4.1's explicit instruction to set route here, and
-- tool.schema.json's own route field example convention ('/ideas').
update core.app
set kind = 'ui',
    route = '/prompts'
where id = 'prompt-organizer';
