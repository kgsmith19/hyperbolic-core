-- FR-006: the one dependency edge docs/notes/2026-08-06-supabase-project-topology.md
-- section 3 states as a literal, named pair: "constraint-finder depends_on
-- optimize-metrics" ("the dependency edges you already identified go
-- straight in"). Idempotent on (idea_id, depends_on) (PROP-022), same
-- pattern as the idea.idea seed (SPEC-0000 PROP-003).
--
-- Deliberately not seeded here: the note's further claim "every scoring
-- tool depends on optimize-metrics" is a general rule, not an enumerated
-- list. Which ideas count as "scoring tools" is Kyle's judgment, not this
-- implementer's to infer from one-liner text (PRD Q-003, unanswered).
insert into idea.dependency (idea_id, depends_on, reason) values (
  'constraint-finder',
  'optimize-metrics',
  'Constraint Finder reads metric data to find bottlenecks; Optimize Metrics owns the metric definitions that data is measured against.'
)
on conflict (idea_id, depends_on) do nothing;
