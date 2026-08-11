-- Reverts 20260807050000_prompt_create_tag.sql: removes exactly what it
-- added. Dropping the table removes its policies and grants with it; no
-- separate revoke is needed (nothing outside prompt.tag was touched).
drop table if exists prompt.tag;
