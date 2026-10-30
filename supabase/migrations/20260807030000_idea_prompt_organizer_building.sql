-- Prompt Organizer's SL-000 implementation started (SPEC-0000 in that repo,
-- its ASM-003): idea.idea tracks reality, so specced -> building.
update idea.idea set status = 'building', updated_at = now()
where id = 'prompt-organizer';
