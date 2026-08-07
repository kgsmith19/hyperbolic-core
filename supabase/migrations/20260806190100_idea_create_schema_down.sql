-- Down migration for 20260806190100_idea_create_schema.sql (AC-007).
drop table if exists idea.score;
drop table if exists idea.dependency;
drop table if exists idea.idea;
drop schema if exists idea;
