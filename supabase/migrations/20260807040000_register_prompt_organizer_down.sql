-- Reverts 20260807040000_register_prompt_organizer.sql.
delete from core.app where id = 'prompt-organizer';
