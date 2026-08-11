---
title: Supabase Project Topology for the Tool Portfolio
status: active
scope: repo
created: 2026-08-06
updated: 2026-08-06
owner: Kyle
---

# Supabase Project Topology

## Recommendation

**Use two new-to-you logical homes and reuse what you already have. Do not create a project per tool.**

| Project | Status | Holds | Why |
|---|---|---|---|
| `toolbelt` | **create** | Meta layer, agentic tooling, discovery, knowledge, optimization engines, Prompt Organizer, the idea registry | These tools read each other's data constantly. Cost-Per-Outcome cannot score anything it cannot join to. |
| `lifeos` | **reuse (exists)** | Personal instrumentation, Decision Journal, Optimize Life, Consistency Engine, Cognitive Load Balancer | Different data sensitivity, different retention, already exists and already has the right shape of data |
| `lifeos-test` | **reuse (exists)** | Phase 0 skeletons, throwaway experiments, migration rehearsals | You already treat it as scratch. Keep it scratch. |
| `netcheck`, `marketmind` | leave alone | their own products | Real products with their own users stay separate |

**Separation inside `toolbelt` is by Postgres schema, not by project.** One schema per tool, plus a shared `core` schema holding the spine every tool writes to.

### Why not a project per tool

| Cost | Detail |
|---|---|
| Money | $10/month per additional project on your Pro org (confirmed against the billing API on 2026-08-06). 33 tools as separate projects is $330/month before any usage. |
| Joins | Cross-project queries need a foreign data wrapper or application-level joins. Cost-Per-Outcome, Constraint Finder, and Autonomy Trust Calibrator all read data produced by every other tool. Splitting them across projects makes their core query the hardest part of the product. |
| Migration overhead | 33 migration histories, 33 sets of credentials, 33 CI configurations |
| Auth | One user identity across tools requires either a shared project or federated auth you would have to build |

🟢 **Recommended path**: one `toolbelt` project, schema-per-tool, split later on evidence. Postgres schemas give you namespace isolation, per-schema grants, and per-schema RLS. That is nearly all the isolation a project boundary provides, at zero marginal cost.

### The decision rule: when a tool earns its own project

Split a tool out only when at least one is true. Write down which one.

| # | Trigger |
|---|---|
| 1 | It has external users who are not you |
| 2 | Its data is under a compliance regime the rest is not (health records, payment card data, another party's customer data) |
| 3 | It needs a different region for latency or residency |
| 4 | Its load would degrade the others (sustained heavy write or long analytical queries) |
| 5 | It needs a different Postgres major version or extension set that conflicts |
| 6 | It is being handed to someone else, or sold |

🟡 **The tradeoff you are accepting**: one project means one blast radius. A bad migration, a runaway query, or a compute exhaustion event affects every tool at once. Mitigations: use Supabase branches for every migration rehearsal, put per-schema `statement_timeout` on the roles that run analytics, and keep `lifeos-test` as the place risky things get tried first. For a personal tool portfolio this is the right trade. For anything with paying users it is not.

---

## 1. Project assignment for every idea

| # | Idea | Project | Schema | Owns / Reads |
|---|---|---|---|---|
| **Meta layer (build first)** |
| 1 | Optimize Metrics | toolbelt | `core` | **Owns** `metric_def`. Every scoring tool reads it. |
| 2 | Constraint Finder | toolbelt | `constraint` | Reads `core.metric_value`, `core.run`, `core.cost` |
| 3 | Cost-Per-Outcome Tracker | toolbelt | `core` | **Owns** `run`, `cost`, `outcome` |
| 4 | Decision Journal + Outcome Scoring | **lifeos** | `decision` | Personal judgment data. Aggregates only pushed to `toolbelt`. |
| 5 | Step Back | toolbelt | `stepback` | Reads `core.outcome`, `idea.idea` |
| 6 | Assumption Ledger | toolbelt | `core` | **Owns** `assumption`. Fed by every agentic run. |
| 7 | Autonomy Trust Calibrator | toolbelt | `autonomy` | Reads `core.run`, `core.intervention` |
| **Agentic / LLM systems tooling** |
| 8 | **Prompt Organizer** (priority) | toolbelt | `prompt` | **Owns** `prompt`, `prompt_version`, `variable`, `config`, `render` |
| 9 | Instruction Optimizer | toolbelt | `prompt` | Same schema as Prompt Organizer. They are one data model. |
| 10 | Prompt/Agent Regression Tracker | toolbelt | `prompt` | **Owns** `eval_case`, `eval_run` |
| 11 | LLM-to-Rules-Based Transition | toolbelt | `agentic` | Reads `core.run`, `prompt.render` |
| 12 | Reformat Code/Context for LLM Readability | toolbelt | `agentic` | Mostly stateless. One table for measured before/after. |
| 13 | Context Rot Detector | toolbelt | `agentic` | Reads `core.run` |
| 14 | Tool Optimizer / Connect Lite | toolbelt | `agentic` | **Owns** `tool_call` |
| 15 | Agent Provenance Graph | toolbelt | `core` | **Owns** `event`. This is the spine's event log. |
| **Optimization engines** |
| 16 | Autonomous Optimizer | toolbelt | `optimize` | Reads everything in `core` |
| 17 | Workflow Time-Lag Analyzer | toolbelt | `optimize` | Reads `core.run`, `core.event` |
| 18 | Promo Optimizer | toolbelt | `optimize` | Standalone; move out if it ever gets external users |
| 19 | Optimize Life | **lifeos** | `optimize` | Personal data |
| **Self-healing** |
| 20 | Self-Correcting Code | toolbelt | `healing` | **Owns** `defect`, `repair_attempt` |
| 21 | Tiered Error-Logging | toolbelt | `healing` | **Owns** `error_event`. Highest write volume: watch it. |
| **Discovery and problem solving** |
| 22 | Idea Generator | toolbelt | `idea` | **Owns** `idea`, `idea_score`. This is the home for your list. |
| 23 | Golden Goose | toolbelt | `idea` | Reads and scores `idea.idea` |
| 24 | Right Under My Nose | toolbelt | `idea` | Reads `core.event`, writes `idea.idea` |
| 25 | Break It Down / Reduce Complexity | toolbelt | `idea` | Mostly stateless |
| 26 | Unconstrained Solver | toolbelt | `idea` | Mostly stateless |
| **Personal instrumentation** |
| 27 | Personal Correlation Engine | **lifeos** | `personal` | Personal, possibly health-adjacent |
| 28 | Learn XYZ App | **lifeos** | `learn` | Personal |
| 29 | Cognitive Load Balancer | **lifeos** | `personal` | Personal |
| 30 | Consistency Engine | **lifeos** | `personal` | Personal |
| **Knowledge and documentation** |
| 31 | Knowledge Half-Life Tracker | toolbelt | `knowledge` | **Owns** `artifact`, `staleness_signal` |
| 32 | Reverse Requirements Extractor | toolbelt | `knowledge` | Reads repos, writes `knowledge.extracted_requirement` |
| **Timing** |
| 33 | Timing / Opportunity Scanner | toolbelt | `timing` | Reads `core.metric_value`, `idea.idea` |

**Schema count in `toolbelt`: 11** (`core`, `prompt`, `agentic`, `constraint`, `autonomy`, `stepback`, `optimize`, `healing`, `idea`, `knowledge`, `timing`). That is a comfortable number for one Postgres database.

🟡 **The one real cost of putting Decision Journal in `lifeos`**: Cost-Per-Outcome (in `toolbelt`) wants to correlate your decisions with outcomes, and that join now crosses projects. Do not solve this with a foreign data wrapper. Push a **de-identified daily aggregate** from `lifeos` into `toolbelt.core.metric_value` instead: decision count, calibration score, outcome-scored share. You lose row-level joins and keep the privacy boundary, which is the correct trade for personal judgment data.

---

## 2. The `core` spine

Every tool writes to this. Getting it right once is what makes the meta layer possible at all; getting it wrong means every scoring tool builds its own incompatible version.

```sql
create schema if not exists core;

-- Registry of every tool in the portfolio.
create table core.app (
  id            text primary key,              -- 'prompt-organizer'
  name          text not null,
  schema_name   text not null,
  status        text not null default 'idea'   -- idea|building|live|retired
                check (status in ('idea','building','live','retired')),
  created_at    timestamptz not null default now()
);

-- One row per execution of anything worth measuring.
create table core.run (
  id            uuid primary key default gen_random_uuid(),
  app_id        text not null references core.app(id),
  kind          text not null,                 -- 'agent'|'workflow'|'slice'|'review'|'job'
  ref           text,                           -- spec id, prompt id, commit sha
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  status        text not null default 'running'
                check (status in ('running','ok','failed','halted')),
  user_id       uuid references auth.users(id) default auth.uid()
);
create index on core.run (app_id, started_at desc);

-- Append-only event log. Agent Provenance Graph owns this.
create table core.event (
  id            bigint generated always as identity primary key,
  run_id        uuid not null references core.run(id) on delete cascade,
  parent_id     bigint references core.event(id),   -- provenance edge
  at            timestamptz not null default now(),
  kind          text not null,                       -- 'tool_call'|'llm_call'|'decision'|'gate'|'halt'
  name          text not null,
  payload       jsonb not null default '{}'::jsonb
);
create index on core.event (run_id, at);
create index on core.event using gin (payload jsonb_path_ops);

-- Cost, one row per run. Cost-Per-Outcome owns this.
create table core.cost (
  run_id            uuid primary key references core.run(id) on delete cascade,
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  llm_calls         int    not null default 0,
  tool_calls        int    not null default 0,
  wall_clock_ms     bigint not null default 0,
  interventions     int    not null default 0,   -- human turns that corrected course
  usd               numeric(12,6) not null default 0
);

-- What actually shipped. The denominator for every ROI question.
create table core.outcome (
  id            uuid primary key default gen_random_uuid(),
  app_id        text not null references core.app(id),
  kind          text not null,                  -- 'requirement'|'slice'|'defect_fixed'|'decision'
  ref           text not null,                  -- FR-012, SL-007
  shipped_at    timestamptz not null default now(),
  value_note    text
);

-- Many-to-many: several runs produce one outcome; one run can serve several.
create table core.run_outcome (
  run_id      uuid references core.run(id) on delete cascade,
  outcome_id  uuid references core.outcome(id) on delete cascade,
  primary key (run_id, outcome_id)
);

-- Optimize Metrics owns the definition; everything else owns values.
create table core.metric_def (
  id             text primary key,             -- 'cost_per_requirement'
  name           text not null,
  formula        text not null,                -- unambiguous, in words
  unit           text not null,
  is_proxy       boolean not null default false,
  gaming_risk    text not null,                -- how it could be gamed; required
  supersedes     text references core.metric_def(id),
  created_at     timestamptz not null default now()
);

create table core.metric_value (
  metric_id   text not null references core.metric_def(id),
  app_id      text references core.app(id),
  at          timestamptz not null default now(),
  value       numeric not null,
  window      text,                             -- 'day'|'week'|'slice'
  primary key (metric_id, app_id, at)
);

-- Assumption Ledger. Written by every agentic run.
create table core.assumption (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references core.run(id) on delete set null,
  app_id        text references core.app(id),
  statement     text not null,
  why_needed    text not null,
  how_to_verify text not null,
  blast_radius  text not null check (blast_radius in ('low','medium','high')),
  status        text not null default 'unverified'
                check (status in ('unverified','verified','false')),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

-- Autonomy Trust Calibrator reads this.
create table core.intervention (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references core.run(id) on delete cascade,
  at             timestamptz not null default now(),
  decision_type  text not null,                -- 'naming'|'schema'|'dependency'|'test_level'|...
  was_halt       boolean not null,             -- agent asked, vs human interrupted
  was_correction boolean not null,             -- the agent's choice was actually wrong
  note           text
);
```

**The `gaming_risk` column on `metric_def` is `not null` on purpose.** Optimize Metrics exists to stop you trusting proxy metrics; a metric that has not had its gaming risk written down does not get to exist.

---

## 3. The idea registry

Your list needs a home before anything else can prioritize against it.

```sql
create schema if not exists idea;

create table idea.idea (
  id            text primary key,              -- 'optimize-metrics'
  name          text not null,
  category      text not null,                 -- 'meta'|'agentic'|'optimization'|...
  one_liner     text not null,
  problem       text,
  status        text not null default 'idea'
                check (status in ('idea','specced','building','live','parked','killed')),
  app_id        text references core.app(id),  -- set when it becomes real
  project       text not null default 'toolbelt',
  schema_name   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Which ideas unlock which. Build order falls out of this graph.
create table idea.dependency (
  idea_id      text references idea.idea(id) on delete cascade,
  depends_on   text references idea.idea(id) on delete cascade,
  reason       text not null,
  primary key (idea_id, depends_on)
);

-- Scores are versioned, never overwritten, so you can see your judgment change.
create table idea.score (
  id           uuid primary key default gen_random_uuid(),
  idea_id      text not null references idea.idea(id) on delete cascade,
  metric_id    text not null references core.metric_def(id),
  value        numeric not null,
  scored_at    timestamptz not null default now(),
  scored_by    text not null                    -- 'kyle'|'agent:golden-goose'
);
```

The dependency edges you already identified go straight in: `constraint-finder depends_on optimize-metrics`, and every scoring tool depends on `optimize-metrics`. Once the graph is loaded, build order is a topological sort rather than a debate.

---

## 4. Row-level security baseline

Apply to every table in every schema, in the same migration that creates the table. Never as a follow-up.

```sql
alter table <schema>.<table> enable row level security;
alter table <schema>.<table> force row level security;  -- applies to table owner too

create policy owner_all on <schema>.<table>
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

Rules:

| Rule | Why |
|---|---|
| RLS enabled **and forced** on every table | `enable` alone does not constrain the table owner, which is how "RLS is on" becomes false in practice |
| Tables without a `user_id` (reference data like `core.metric_def`) get an explicit read-only-to-authenticated policy | Silence is not a policy |
| The service-role key never reaches a client, a browser bundle, or an edge function that takes untrusted input | It bypasses RLS entirely |
| Cross-schema reads go through a `security definer` view with an explicit policy, never through a broad grant | Keeps the boundary auditable |
| Every RLS policy gets exactly one test that a second user cannot read the first user's row | The policy is the mechanism; one test proves it is switched on |

---

## 5. Conventions

| Topic | Convention |
|---|---|
| Migration files | `YYYYMMDDHHMMSS_<schema>_<verb>_<object>.sql`, e.g. `20260806143000_prompt_create_prompt_version.sql` |
| Down migrations | Pair every up migration with a down migration so schema changes remain explicit and reversible. |
| Rehearsal | Every migration runs on a Supabase **branch** first, then `lifeos-test`, then production. |
| Table names | Singular (`prompt`, not `prompts`). Consistency beats preference. |
| Primary keys | `uuid` with `gen_random_uuid()` for user-facing rows; `bigint identity` for high-volume append-only logs |
| Timestamps | `timestamptz` always. Never `timestamp`. |
| Money | `numeric`, never float |
| JSON | `jsonb`, with a GIN index only when a query actually needs it |
| Enum-like columns | `text` plus a `check` constraint, not a Postgres `enum` type (enums cannot drop values without a rewrite) |
| Cross-schema FK | Allowed only into `core`. Tool schemas never reference each other directly; that coupling is what schemas exist to prevent. |
| Generated types | Regenerate TypeScript types in the same commit as the migration |
| Retention | Every append-only table (`core.event`, `healing.error_event`) gets a retention policy and a job in the slice that creates it, not later |

🔴 **The one thing that will actually bite you**: `core.event` and `healing.error_event` are unbounded-growth tables written by every tool. Without a retention policy from day one, they become the reason a shared project was a bad idea. Add partitioning by month and a 90-day drop policy in the slice that creates them.

---

## 6. Build order

Derived from the dependency graph, not from enthusiasm.

| Order | Build | Why it is first |
|---|---|---|
| 1 | `core` spine + `idea` registry (one Phase 0 slice) | Nothing can be measured or prioritized without them. This is a genuinely tiny slice: eight tables, no UI beyond a list. |
| 2 | **Prompt Organizer** | You named prompt-writing as your biggest time sink. It is the highest-ROI item on the list and it is independent of everything else. |
| 3 | Optimize Metrics | Makes `core.metric_def` trustworthy. Every scoring tool inherits its validity. |
| 4 | Cost-Per-Outcome Tracker | Fills `core.cost` and `core.outcome`. Now you can score whether steps 2 and 3 paid for themselves. |
| 5 | Constraint Finder | Uses trustworthy metrics to tell you what to build sixth. |

Steps 1 and 2 before 3 is a deliberate deviation from "meta layer first". The reason: Optimize Metrics needs real data to be tested against, and the Prompt Organizer generates it while paying for itself immediately. Building a metrics framework with no data flowing through it is the exact speculative-generality trap the kernel prohibits.

---

## 7. Open questions

| # | Question | Blocks | Default if unanswered |
|---|---|---|---|
| 1 | Does the Prompt Organizer need to serve anyone but you in the next 12 months? | Whether it stays in `toolbelt` | Assume no; keep it in `toolbelt` |
| 2 | Is `marketmind` still alive, or should it be deleted? It has been INACTIVE since creation. | $10/month and one less thing to think about | Delete it; restore from backup if wrong |
| 3 | Where do agent runs actually get instrumented: a wrapper library, a hook, or manual writes? | Whether `core.run` ever has real data | A thin wrapper library, one function, written in the `core` slice |
| 4 | Retention for `core.event`: 90 days, or longer for provenance? | Storage growth | 90 days hot, monthly aggregate kept forever |
