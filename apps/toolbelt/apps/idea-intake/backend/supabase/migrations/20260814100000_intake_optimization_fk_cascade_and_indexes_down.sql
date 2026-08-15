-- Reverts 20260814100000_intake_optimization_fk_cascade_and_indexes.sql:
-- restores both foreign keys to their original ON DELETE NO ACTION (the
-- Postgres default for a bare REFERENCES clause, exactly what
-- 20260813002605_intake_create_schema.sql originally declared) and drops
-- the two supporting indexes.
alter table intake.optimization
  drop constraint optimization_input_idea_id_fkey,
  add constraint optimization_input_idea_id_fkey
    foreign key (input_idea_id) references intake.idea(id);

alter table intake.optimization
  drop constraint optimization_output_idea_id_fkey,
  add constraint optimization_output_idea_id_fkey
    foreign key (output_idea_id) references intake.idea(id);

drop index if exists intake.optimization_output_idea;
drop index if exists intake.optimization_input_idea;
