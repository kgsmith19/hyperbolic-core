import { test } from "node:test";
import assert from "node:assert/strict";
import { rest, primaryToken } from "./helpers.mjs";

// The oracle: transcribed independently from
// docs/notes/2026-08-06-supabase-project-topology.md section 1, not derived
// from the seed migration file, so a drift between the two is caught.
const EXPECTED = [
  ["optimize-metrics", "Optimize Metrics", "Meta layer"],
  ["constraint-finder", "Constraint Finder", "Meta layer"],
  ["cost-per-outcome-tracker", "Cost-Per-Outcome Tracker", "Meta layer"],
  ["decision-journal-outcome-scoring", "Decision Journal + Outcome Scoring", "Meta layer"],
  ["step-back", "Step Back", "Meta layer"],
  ["assumption-ledger", "Assumption Ledger", "Meta layer"],
  ["autonomy-trust-calibrator", "Autonomy Trust Calibrator", "Meta layer"],
  ["prompt-organizer", "Prompt Organizer", "Agentic / LLM systems tooling"],
  ["instruction-optimizer", "Instruction Optimizer", "Agentic / LLM systems tooling"],
  ["prompt-agent-regression-tracker", "Prompt/Agent Regression Tracker", "Agentic / LLM systems tooling"],
  ["llm-to-rules-based-transition", "LLM-to-Rules-Based Transition", "Agentic / LLM systems tooling"],
  ["reformat-code-context-for-llm-readability", "Reformat Code/Context for LLM Readability", "Agentic / LLM systems tooling"],
  ["context-rot-detector", "Context Rot Detector", "Agentic / LLM systems tooling"],
  ["tool-optimizer-connect-lite", "Tool Optimizer / Connect Lite", "Agentic / LLM systems tooling"],
  ["agent-provenance-graph", "Agent Provenance Graph", "Agentic / LLM systems tooling"],
  ["autonomous-optimizer", "Autonomous Optimizer", "Optimization engines"],
  ["workflow-time-lag-analyzer", "Workflow Time-Lag Analyzer", "Optimization engines"],
  ["promo-optimizer", "Promo Optimizer", "Optimization engines"],
  ["optimize-life", "Optimize Life", "Optimization engines"],
  ["self-correcting-code", "Self-Correcting Code", "Self-healing"],
  ["tiered-error-logging", "Tiered Error-Logging", "Self-healing"],
  ["idea-generator", "Idea Generator", "Discovery and problem solving"],
  ["golden-goose", "Golden Goose", "Discovery and problem solving"],
  ["right-under-my-nose", "Right Under My Nose", "Discovery and problem solving"],
  ["break-it-down-reduce-complexity", "Break It Down / Reduce Complexity", "Discovery and problem solving"],
  ["unconstrained-solver", "Unconstrained Solver", "Discovery and problem solving"],
  ["personal-correlation-engine", "Personal Correlation Engine", "Personal instrumentation"],
  ["learn-xyz-app", "Learn XYZ App", "Personal instrumentation"],
  ["cognitive-load-balancer", "Cognitive Load Balancer", "Personal instrumentation"],
  ["consistency-engine", "Consistency Engine", "Personal instrumentation"],
  ["knowledge-half-life-tracker", "Knowledge Half-Life Tracker", "Knowledge and documentation"],
  ["reverse-requirements-extractor", "Reverse Requirements Extractor", "Knowledge and documentation"],
  ["timing-opportunity-scanner", "Timing / Opportunity Scanner", "Timing"],
];

// T-I-005 -> AC-005, PROP-005 -> FR-001
test("seeded_idea_count_is_exactly_33__T_I_005__AC_005", async () => {
  const token = await primaryToken();
  const { status, json } = await rest("idea", "idea?select=id", { token });
  assert.equal(status, 200);
  assert.equal(json.length, 33);
});

test("seeded_ids_names_categories_match_topology_note__T_I_005__PROP_005", async () => {
  const token = await primaryToken();
  const { json } = await rest("idea", "idea?select=id,name,category&order=id.asc", { token });
  const actual = json.map((r) => [r.id, r.name, r.category]).sort((a, b) => a[0].localeCompare(b[0]));
  const expected = [...EXPECTED].sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(actual, expected);
});

// PROP-003 (idempotent seed) was verified manually during the down/up
// rollback drill in SPEC-0000 section 12 evidence: re-running the seed
// migration (ON CONFLICT DO NOTHING) left the count at 33, not 66. Not
// re-run here because it requires applying a migration, which these tests
// (calling only the public REST/Auth APIs) cannot do without DB credentials.
