-- Down migration for 20260813120000_prompt_create_get_prompt_function.sql.
drop function if exists prompt.get_prompt(text, integer, text, jsonb, text[]);
