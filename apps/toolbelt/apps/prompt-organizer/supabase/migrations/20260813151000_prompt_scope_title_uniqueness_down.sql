-- Restores the V0 global title contract. This deliberately fails rather than
-- deleting data if different principals created equal titles after the up
-- migration; an operator must reconcile that data before rolling back.
drop index prompt.prompt_title_unique;
create unique index prompt_title_unique
  on prompt.prompt (lower(title));
