-- Down migration for 20260806190300_seed_idea.sql: removes exactly the 33 seeded ids.
delete from idea.idea where id in (
  'optimize-metrics','constraint-finder','cost-per-outcome-tracker','decision-journal-outcome-scoring',
  'step-back','assumption-ledger','autonomy-trust-calibrator','prompt-organizer','instruction-optimizer',
  'prompt-agent-regression-tracker','llm-to-rules-based-transition','reformat-code-context-for-llm-readability',
  'context-rot-detector','tool-optimizer-connect-lite','agent-provenance-graph','autonomous-optimizer',
  'workflow-time-lag-analyzer','promo-optimizer','optimize-life','self-correcting-code','tiered-error-logging',
  'idea-generator','golden-goose','right-under-my-nose','break-it-down-reduce-complexity','unconstrained-solver',
  'personal-correlation-engine','learn-xyz-app','cognitive-load-balancer','consistency-engine',
  'knowledge-half-life-tracker','reverse-requirements-extractor','timing-opportunity-scanner'
);
