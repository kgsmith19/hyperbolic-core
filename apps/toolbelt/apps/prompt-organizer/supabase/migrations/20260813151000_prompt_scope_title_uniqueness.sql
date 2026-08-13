-- A SECURITY DEFINER lookup must never let an inaccessible legacy fixture row
-- reserve a name for the configured owner. Keep case-insensitive uniqueness,
-- but scope it to the row principal just like every prompt read and write.
-- The index name is preserved so PostgREST's stable 23505 contract remains
-- unchanged for duplicate owner titles.
drop index prompt.prompt_title_unique;
create unique index prompt_title_unique
  on prompt.prompt (user_id, lower(title));
