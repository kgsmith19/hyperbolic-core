-- Down migration for 20260813150000_prompt_create_get_prompt_source_function.sql.
revoke execute on function prompt.get_prompt_source(text, integer, integer)
  from prompt_get_agent;
drop function if exists prompt.get_prompt_source(text, integer, integer);
