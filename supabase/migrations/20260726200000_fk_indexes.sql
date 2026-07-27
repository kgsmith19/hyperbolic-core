-- Covering indexes for the two kernel foreign keys flagged by the database
-- linter (entity_type.type_id, type_definition.parent_type_id). Kernel-only
-- DDL; reviewed against invariant 1 — no domain surface.
create index if not exists entity_type_type_id_idx
    on entity_type (type_id);
create index if not exists type_definition_parent_type_id_idx
    on type_definition (parent_type_id);
