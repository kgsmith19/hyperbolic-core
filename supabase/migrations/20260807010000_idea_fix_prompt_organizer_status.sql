-- FR-001/AC-001 require idea.idea's prompt-organizer row to carry status
-- 'specced'. The original seed wrote 'idea'; 'specced' was the accepted
-- status, so the seed was the defect.
-- 20260806190300_seed_idea.sql is corrected too, for fresh deploys.
update idea.idea set status = 'specced', updated_at = now()
where id = 'prompt-organizer';
