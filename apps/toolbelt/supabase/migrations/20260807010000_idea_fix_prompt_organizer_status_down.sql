-- Reverts 20260807010000_idea_fix_prompt_organizer_status.sql.
update idea.idea set status = 'idea', updated_at = now()
where id = 'prompt-organizer';
