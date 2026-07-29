# lifeos: Research Synthesis (v3, 2026-07-29)

> Destination: `lifeos/docs/research/lifeos-research-2026-07-29.md`. Lands via the
> normal rules-cell PR (declare the cell in `.agents/task.json` first), alongside
> `lifeos-research-final.md` (v2, 2026-07-27), which it extends rather than
> replaces. Point-in-time snapshot; ADRs win on conflict.
>
> Companion to the roadmap changes of the same date. The full evidence base
> (including operator-specific ROI figures and personal context) is deliberately
> NOT in this repo: it stays in the ecosystem-root working files, which are
> x-sensitive and outside git. Cite those by name; never copy their content here.
>
> v2 established that the architecture is right. v3 establishes what the
> architecture should be pointed at, from a second research pass (eight parallel
> agents, ~120 sources, spanning behavior-change evidence, executive-function
> scaffolding, wellbeing-adjacent self-monitoring, metabolic/device data
> ingestion, personal-finance ingestion, relationship-adjacent design ethics,
> labor-market reality, and post-May-2026 agent-platform deltas).

---

## 1. What changed since v2

v2 validated the kernel and produced a 12-slice ranked roadmap from architecture
and product-convergence evidence. It had no user research: no data about which
domains the single user would actually sustain. v3 adds that, and the result
reorders emphasis without touching architecture.

**The headline finding: this system's durable value is adherence, admin, and
restart support, not capture or notes.** Calendar and note-taking, the assumed
core in most comparable products, are supporting context here. The domains with
real sustained-use pull are the ones with numeric bars over ingestible data, and
the ones where a draft or a computation closes a stalled loop.

**Three structural consequences.**

1. **Numeric-bar goals are scoreable like golden questions.** Adherence targets
   (device usage hours, weekly training quotas, trend rates) are deterministic
   math over ingested data, narrated by the model, never computed by it. This
   needs no new machinery: types plus rollups, both already planned.
2. **Delegable knowledge work is a first-class use case.** A meaningful share of
   a real personal backlog is not task-tracking but stalled research errands:
   questions that close when someone produces a prep pack, an options table, or
   a call script with the math already done. This fits inside the existing
   proactivity ceiling (watch / summarize / remind / draft) without extension.
3. **Restart support is a hard requirement, not a nicety.** Real backlogs are
   written in restart language ("resume", "stay consistent", "one full month").
   The evidence on lapse-and-resume (§2.4) makes shame-free resumption a
   design constraint that governs copy, notification policy, and scoring.

---

## 2. Evidence digest (design-relevant findings only)

Labels: [strong] RCT/meta-analysis · [moderate] observational/large-N ·
[community] consistent practitioner reports · [anecdote].

### 2.1 Data visibility is the intervention

- Telemonitoring and self-view of one's own device-adherence data adds roughly
  **+0.5 to +0.76 h/night** of therapy use across two meta-analyses of 18 RCTs
  each; automated feedback matched human-guided delivery [strong]. Large
  observational cohorts show a similar gap between self-view and clinician-only
  monitoring [moderate].
- Implication: for adherence domains, the evidenced mechanism is simply
  **showing the user their own recent record**. A rolling compliance calendar in
  a daily digest is the whole intervention. Nothing more elaborate is required,
  and elaboration is where these systems die.

### 2.2 Rates, bands, and anchors

- Progress-rate targets must be expressed as **percentage of current state with
  expectation bands**, not fixed absolute deltas. An absolute goal line fires
  "behind schedule" alerts precisely when a normal, expected taper begins
  [strong, from behavioral-program outcome literature].
- Self-monitoring gaps predict regression better than slow progress does: the
  actionable alarm is **measurement stopping**, not a slow week [strong/moderate].
- Partial logging retains most of its benefit and decays by design; logging
  decay is normal, not failure [moderate].
- **Standing rule: every displayed formula names its anchor** (current value,
  goal value, rolling window). An unanchored formula silently changes meaning as
  the underlying quantity moves.

### 2.3 Quotas beat streaks

- Median time to habit automaticity is ~66 days, and **missing a single day is
  immaterial** to formation [moderate]. Implementation intentions (stored
  if-then anchors) carry **d≈0.65** on goal attainment [strong]; fresh-start
  landmarks measurably lift restart behavior [moderate].
- Streak mechanics concentrate their retention value in the first week; two
  freezes outperform one and a third adds nothing; losing a long streak drives
  **40-60% abandonment** absent repair mechanics [community]. Practitioner data
  converges on **≤3 enforced goals** before burnout.
- Design: weekly quotas with 1-2 freezes and a 24-hour repair window; stored
  if-then anchors; restart nudges at week and month boundaries; **no daily
  hard-reset streaks, badges, or overdue counts anywhere**.

### 2.4 Lapse-and-resume is the normal usage pattern

- Personal-informatics research finds abandonment driven by upkeep cost,
  discomfort with what data reveals, and "learned enough"; **tracking is
  episodic by nature** and systems should build resumption experiences rather
  than nagging [moderate]. Multi-year self-tracker consensus: passive capture
  survives, manual capture dies except sub-minute check-ins, and **periodic
  reviews beat live dashboards** [community].
- Design: automate every stream that can be automated; keep exactly one manual
  surface; on any multi-day capture gap, produce a welcome-back summary with no
  guilt and no backfill demand.

### 2.5 Concurrency limits

- Multiple-behavior-change literature shows an **inverted U: 2-3 concurrent
  focus areas outperform both 1 and 4+** [moderate]; simultaneous-vs-sequential
  comparisons are inconclusive [strong but null].
- Design: enforce a **maximum of 3 focus items** at the service layer. Everything
  else stays ingested, scored, and silent. The system offers rotation, never
  addition.

### 2.6 Executive-function scaffolding

- External scaffolds outperform internal-skill training; **point-of-action
  cueing** is the best-evidenced micro-mechanism [strong general / moderate in
  clinical adult samples]. Capture must be ≤1 step or the item is lost.
- Retention data is brutal: **~3-4% of installers still active at day 30** for
  the comparable app category [moderate]. The two things that demonstrably
  retain are (a) tools with zero setup and zero maintained state, used at the
  moment of overwhelm, and (b) surfaces that are shame-proof by construction
  [community].
- LLM-specific: **task decomposition and task initiation** are the two
  community-validated wins. Documented risks are novelty mistaken for efficacy,
  and plausible-but-wrong plans accepted uncritically. Every generated plan is
  confirm-before-write.

### 2.7 Wellbeing-adjacent surfaces: what the evidence forbids

This section is load-bearing for ADR 019 and should be read before building any
surface that touches mood, symptoms, or episodes.

- **Monitoring is measurement, not treatment.** Meta-analysis of mood-monitoring
  RCTs finds no meaningful symptom effect in either direction [strong]. Adverse
  events are underreported but real (~4% pooled prevalence) [moderate].
- **Push notifications backfire here.** In mood-tracking trials, reminders
  *reduced* adherence (61% vs 78% without) and increased attrition [moderate].
  Resulting rule: **plans may be pushed; feelings are pull-only.**
- **Reassurance loops are a maintenance mechanism.** Checking behavior yields
  short-term relief and long-term worsening [moderate]. An always-available
  "am I okay?" responder is therefore contraindicated; repeated same-day queries
  should return a pre-authored protocol verbatim rather than fresh generated
  comfort.
- **Prediction is not viable and should not be attempted.** A 2026 meta-analysis
  of digital biomarkers found **null associations across all four wearable sleep
  metrics** [strong]; cross-dataset generalization of published detection models
  fails badly (GLOBEM) [strong]; just-in-time adaptive interventions pool to
  **g=0.15** [strong]. At personal scale the training data does not exist, and a
  false alarm is itself harmful. **Describe co-occurrence; never predict.**
- **Pre-written protocols do change behavior under load.** The strongest adjacent
  evidence comes from structured written safety/crisis planning, which roughly
  halved adverse outcomes and doubled engagement [moderate]; the mechanism rides
  the implementation-intentions literature [strong]. The protocol must be
  **user-authored while well, versioned, and surfaced verbatim**, never generated
  in the moment.
- **Personal base rates are the highest-value derived artifact.** Tracking one's
  own predictions against outcomes shows the overwhelming majority of feared
  predictions do not materialize, and the personally-observed disconfirmation
  rate predicts improvement [moderate]. A system holding an append-only history
  can compute this natively: capture the prediction at onset, resolve it at
  close, show the growing gap. This is the clearest case where the kernel's
  bi-temporal design produces a benefit a notes app structurally cannot.
- Correlation displays across domains must use **co-occurrence language only**;
  causal claims are unsupported at n-of-1 and several plausible mechanisms have
  failed causal testing [moderate].

### 2.8 Ingestion paths that survive

- **Webhook-push from a maintained exporter app** is the lowest-maintenance
  health path (years-stable, works against a tailnet endpoint) [shipped].
- **Device/therapy data via a documented public API**, with a local
  card-reader-plus-cron path as fallback, is the community-standard route
  [shipped/community].
- **Financial data via a bridge service with a read-only access URL** (roughly
  $15/yr, ~25 institutions) is what the self-hosted budgeting community
  converged on; the OAuth-app aggregators are not solo-developer shaped and one
  major free tier closed in 2026. **User-triggered sync, never a daemon**, caps
  breakage blast radius [strong/community].
- **CSV import is the permanent floor** for every ingestion domain: it never
  breaks, and it is the honest fallback when an API lapses.
- Recurring-charge detection **needs no ML**: normalized merchant plus amount
  tolerance plus cadence regularity is what production systems use, and at
  personal scale a deterministic pass is both sufficient and auditable
  [moderate].
- Pay-period windows must be first-class where income is not monthly; calendar-
  month-native tools structurally mislead biweekly earners [community].

### 2.9 Third-party obligations and drafts

- Where an obligation is governed by a documented rule (rental caps, compliance
  thresholds, allowance schedules), the rule is **plain arithmetic** and belongs
  in a deterministic ledger service. Documented enforcement actions in these
  industries justify checking every such ledger [strong].
- Negotiation and dispute outcomes are strongly favorable **when attempted**, and
  most people never attempt [moderate]. The system's job is to make attempting
  cheap: the math, the script, the questions.
- The durable pattern across every credible report: **the model extracts and
  drafts; code computes every number; the human sends.** No credible practice
  auto-sends.

### 2.10 Design ethics for surfaces touching other people

- Personal-informatics ethics literature is unambiguous: tracking that models a
  non-consenting person is rejected, and the relevant failure modes are
  measurement-management (optimizing crude proxies over lived quality) and
  inference about others accumulated incidentally [strong normative].
- Widely-cited relationship "prediction" figures come from post-hoc models that
  do not survive cross-validation; they are marketing, not evidence [strong
  critique]. What *is* well-supported is **stress spillover**: external load
  degrades interaction quality, which argues for expectation-calibration copy on
  high-load days rather than any scoring.
- Design: **model only the user's own behavior and commitments.** Other people
  appear as untyped name strings. No state fields, no sentiment analysis over
  text mentioning them, no drafted intimate messages, no scores of any kind.

### 2.11 Platform deltas worth acting on

- **MCP spec 2026-07-28** [shipped]: stateless core, MCP Apps in-spec, tasks
  extension, JSON Schema 2020-12 for tool schemas, and formal deprecation of
  roots/sampling/logging on a 12-month window. Consequences: typed-entity
  schemas can be expressed natively in tool contracts; **build nothing on
  sampling**; an entity/receipt viewer is a future MCP App rather than SPA growth.
  Migration is a watch-item pending SDK stabilization, not scheduled work.
- **Claude clients now defer MCP tools behind tool search** [shipped]: tool
  *descriptions* are the discoverability surface. Write them for retrieval.
- **Cloud-hosted schedulers cannot reach a tailnet-only host**; the VPS cron
  remains the scheduling spine, and desktop agent clients are consumers of the
  MCP server rather than replacements for it [shipped].
- **π-Bench** (2026): frontier models score only **43-67% on inferring hidden
  user intent** [paper]. This is the quantitative case for the existing
  proactivity ceiling: keep proactivity deterministic and typed. Intent-inferring
  proactivity is not model-ready.
- Agent-memory survey work through 2026 does not overturn v2's rejection of
  external memory frameworks as runtime dependencies [paper].
- Third-party agent-skill marketplaces produced real exfiltration incidents in
  2026, validating first-party-tools-only plus the trifecta boundary [community].
- Local ASR is solved and cheap; community verdict is that **dictation capture
  retains while open-ended voice journaling does not** [community].
- **"AI slop" critique, adopted as a constraint:** if the model authors
  reflective prose, the user stops reflecting and trust in the archive collapses.
  The model summarizes and cites user-authored entries; it never authors them.

---

## 3. Slice-shaping principles derived from the above

These governed the 2026-07-29 roadmap revision and should govern future ones.

1. **No type before its consumer.** Types are registry data (ADR 002): a define
   script, zero code, zero migration. A registry-only change is therefore not a
   slice; it rides the slice whose code consumes it. The A2.5 micro-slice is the
   pattern.
2. **Personal configuration is not schema.** Season, floors, identity spine, and
   thresholds are config consumed by prompts and rollups. v2 already adjudicated
   this ("hard-code the personal core solo; no generic profile machinery").
3. **One write path.** Nothing writes on the user's behalf before the
   approval-gated slice that creates action_proposal → approval →
   authority_receipt. Verbs that would write earlier emit draft text captured
   through the existing form instead, then upgrade to one-click writes by
   reusing that machinery once it exists.
4. **Riders over slices.** Sub-session work is an explicit optional rider on its
   parent slice, never a queue entry.
5. **Not-an-app-problem work stays out of the roadmap.** Where research showed
   the app's causal contribution is small (labor-market outcomes, relationship
   quality, social connection), the contribution is registry rows and prompt
   lines riding existing slices, and the roadmap says so plainly rather than
   inventing slices to look complete.
6. **Constraints collapse into one ADR** rather than scattering across
   invariants.
7. **A usage gate bounds the queue.** Beyond the committed set, nothing starts
   until the core loop shows sustained real use, computed from the system's own
   data. This is the mechanical form of v2's finding that the dominant risk is
   polishing the system instead of living in it.

---

## 4. Do-not-build (additions to v2 §8 and the roadmap anti-deltas)

Every v2 anti-delta stands. Added by this pass:

- Prediction or risk scoring of mood, episodes, or relationship outcomes;
  live physiology dashboards; any "detected" alert.
- Symptom-shaped push notifications of any kind; unlimited reassurance
  responses; high-frequency in-episode prompting; emoji-only mood scores.
- Daily hard-reset streaks, points, badges, pet mechanics, stakes engines,
  all-goals dashboard walls.
- Fields modeling another person's state; relationship scores or ratios;
  model-drafted intimate or apologetic messages; mid-conflict coaching.
- Absolute-delta goal lines for trending quantities; formulas anchored to the
  wrong quantity; any medical-advice or dosing engine; device write-back.
- Required-surface food logging; content libraries for practices; nutrient
  databases or barcode scanning.
- OAuth-app financial aggregators; auto-sync daemons; envelope budgeting;
  ML-based recurring detection; auto-sent disputes; eligibility-API integrations.
- Generic all-documents OCR platforms (scope document capture to a domain when a
  real document exists).
- Application-volume tooling of any kind; job-search CRMs; business
  infrastructure ahead of demand.
- Intent-inferring proactivity; external memory frameworks as runtime;
  third-party agent skills; model-authored journal prose; diagnostic conclusions.

---

## 5. Caveats

- Single-user findings. Effect sizes cited are population-level and are used to
  choose mechanisms, not to predict individual outcomes.
- Wellbeing-adjacent findings inform *product design only*. Nothing in this file
  is clinical guidance, and every surface built from it compiles evidence and
  stops short of conclusions.
- Community-labeled findings are convergent practitioner reports without
  controlled evidence; they are actionable for design but should not be cited as
  established fact.
- Platform items are dated and will age fast; re-check before acting on any of
  them more than a quarter out.
- Operator-specific ROI estimates, prioritization ledgers, and the personal
  context behind the domain choices are deliberately excluded from this repo and
  live in the ecosystem-root working files.
