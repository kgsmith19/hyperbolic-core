-- Reverts 20260807030000_idea_prompt_organizer_building.sql.
update idea.idea set status = 'specced', updated_at = now()
where id = 'prompt-organizer';
