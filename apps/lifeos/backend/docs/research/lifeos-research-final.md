# lifeos: Finalized Research Synthesis (v2, 2026-07-27)

> Point-in-time snapshot. Merged from two independent deep-research runs (Claude, ChatGPT)
> over the same prompt, evaluated against each other. Solo-use-forever context applied
> throughout: one user, never sold, pure personal ROI. This file is the evidence trail
> behind the roadmap and is expected to age; binding decisions live in ADRs, and when a
> claim here conflicts with a later ADR, the ADR wins.

---

## 1. Verdict

**Keep the kernel. Narrow the near-term promise. Ship AI value now.**

- The event-sourced, bi-temporal, plugins-as-data kernel with scoped services is validated twice over, from opposite directions:
  - **Infrastructure convergence:** Zep/Graphiti independently arrived at the same bi-temporal, supersede-never-delete fact model (arXiv:2501.13956). Letta, LangGraph, and OpenBrain converge on services/MCP-as-only-door and episodic-vs-derived separation, which lifeos already has.
  - **Product convergence:** the surviving typed-object products (Capacities objects, Tana supertags) are the consumer-grade version of type_definition. Typed objects beat generic pages when data will be queried later.
- Do not replace with: pure vector-memory stack, raw text-to-SQL chat, microservices, an external memory framework as runtime, or a second graph substrate.
- **Adjust the vision:** not "one Jarvis that knows everything" on day one, but an evidence-first life copilot. One visible assistant, many hidden scoped specialists, deterministic access to authoritative facts, provenance on every answer, narrow proactive loops. Jarvis emerges by composition.
- **The real risks are not architectural.** They are (a) capture friction, (b) over-ambitious autonomy, (c) polishing the kernel instead of shipping loops. Every surviving comparable minimizes manual filing (mymind: "organize nothing"; Capacities: "organizing has become the work" is the enemy) and keeps proactivity at watch/summarize/remind/draft, never act-broadly.

## 2. Failure modes to design against (from post-mortems)

- **Capture fatigue kills these projects.** "Papers" second brain: 2,847 saved, 84 read, self-scored -99.4% ROI. Manual multi-field logging decays; ingestion-driven capture survives. Exception that survives: sub-minute subjective check-ins paired with automatic data (Exist's entire model).
- **Beautiful vault, generic answers.** 4,000-note vaults produce generic AI answers because nothing is in a queryable shape. Typed entities fix this only if retrieval is wired correctly (hybrid + provenance + compute-then-narrate).
- **Unaccountable AI plateaus trust.** Products that show which notes/entities produced an answer (Capacities cited answers, Zep provenance) retain trust; "AI over your stuff" without receipts does not.
- **Ambient always-on capture is a minefield.** Avoid record-everything as a wedge (hardware-pendant category contraction is the cautionary signal; claim unverified but the principle holds independently).
- **Second task manager by accident.** If a system of record already exists (tasks, calendar), ingest it. Never require duplicate maintenance.

## 3. AI-to-database integration (the recommended stack)

Layered, not one method:

1. **Typed service tools are the primary path** (find, get_entity, history, list_types, narrow writes), wrapped as MCP. Never expose raw SQL or raw tables.
   - Evidence: raw text-to-SQL hallucinated 15-52% across commercial models (2026 study). Semantic-layer grounding raised Claude Sonnet 4.6 from 90.0% to 98.2% and GPT-5.3-Codex from 84.1% to 100.0% (dbt Labs 2026); messy real-world data ~40% raw vs ~83% grounded. Your services ARE the semantic layer.
   - MCP is packaging and interoperability, not the architecture. Quality lives in the tool contracts underneath. Cross-tool openness (Claude Desktop, any MCP client) is a strategic asset for a solo user.
2. **Deterministic temporal rollups for correlation questions.** "How did sleep affect workouts around stressful weeks" is answered by computed aggregates (compare-periods, before/after-event, during-weeks-tagged-X query helpers) that the model narrates. Compute first, narrate second. Retrieval alone under-serves this.
3. **Hybrid lexical + vector retrieval for fuzzy recall.** pgvector paired with Postgres full-text search plus reranking. Anthropic contextual retrieval: 67% reduction in top-20 retrieval failures (5.7% to 1.9%, self-reported). Pure vector similarity is necessary, not sufficient.
4. **Embed derived summaries, never raw events.** Per-entity rolling summaries, per-day and per-week summaries, session summaries; model-tagged, rebuildable by replay (the embedding table is already built for this). LongMemEval: granularity, time-aware expansion, and abstention dominate outcomes; raw event streams produce small, repetitive, temporally ambiguous fragments.
5. **Thin conversational memory beside the kernel, never as truth.** Preferences, active goals, session summaries. The kernel event log stays canonical. Zep's temporal-graph advantage on LongMemEval temporal sub-task (63.8% vs Mem0 49.0% with GPT-4o, directional) is native to lifeos already; do not add mem0/Letta as a dependency.
6. **Context discipline: just-in-time, not preload.** Tiny always-on core (identity spine summary, active goals, preferences; hard-coded is fine solo), everything else via tool call. Anthropic memory tool + context editing: +39% over baseline, 84% token reduction on a 100-turn eval (self-reported). Long contexts degrade ("context rot").
7. **Anti-hallucination mechanics:** require tool use for factual claims; structured tool outputs; provenance in every retrieved chunk; answers cite the entities/events used; aggregation computed by the app, narrated by the model.
8. **GraphRAG: only for unstructured content.** You already have the structured graph; query it directly. GraphRAG-like expansion applies to journals, notes, and documents where structure must be recovered. Do not add a second graph substrate.

## 4. Architecture for sectioned-but-unified

- **Modular monolith, permanently.** Solo forever removes the last argument for services-per-domain or per-domain APIs. The boring option wins decisively.
- **Cross-domain composability is the structural advantage:** one entity graph means cross-domain questions are edges plus time filters, no cross-service joins. Sectioning lives in tools, scopes, and pages, not in storage.
- **Graph is implementation, not UX.** Users of Tana/Reflect experience notes, dailies, and search, not graph browsers. lifeos UI stays: section pages, chat, capture forms, timelines.
- **Orchestration in an app-owned sidecar, not an external agent platform.** One visible assistant; hidden scoped specialists (health analyst, relationship copilot, scheduler, capture formatter) via subagent/handoff patterns. LangGraph only if long-running resumable workflows ever demand it, and then as a runtime over lifeos tools, never a second source of truth.

## 5. Conversational and proactive layer

- **Reactive first:** grounded chat with citations over MCP read tools is the core experience and ships in days.
- **Proactive = watch, summarize, remind, draft. Never silent external mutation.** Cron on the VPS: daily/next-24h briefing, weekly health-workout summary, overdue digest, birthdays, "people I'm drifting from," "you said you wanted to do X this week." This is the durable pattern across Monica, Exist, Oura reports, Khoj automations, OpenAI/Anthropic scheduled tasks.
- **Mobile: installable PWA over Tailscale + Web Share Target + quick capture (text, link, image, voice memo to structured entry).** Capture in the flow of life is the first mobile win, not a native app and not chat-first. Tailnet clients exist for iOS/Android; no new attack surface.
- **Voice is two jobs:** (a) dictation quick-capture, early and cheap; (b) realtime conversational voice (local Whisper, optional Piper, or LiveKit-class stack), later. Never the blocker.

## 6. Trust, privacy, safety

- **The trifecta invariant holds and is stricter than the field's rule.** Willison's lethal trifecta (private data + untrusted content + external comms) and Meta's Agents Rule of Two (at most two of: untrusted input, sensitive access, state-change/external comms) are the industry articulation. Keep yours as a hard architectural boundary.
- **Enforce mechanically, not by discipline.** Scope drift is silent (read-only becomes drafting becomes sending). Enforcement = AccessContext scopes on per-agent tokens, from the first agent.
- **Formal tool/approval classes:** read-only analyst; summarize/draft; schedule/remind; external-communicate (approval-required); execute-write (approval-required). Encode as scope bundles.
- **Input filtering is not a defense.** Adaptive attacks bypassed 12 recent injection defenses at >90% ASR; human red-teaming hit 100% (arXiv:2510.09023, joint OpenAI/Anthropic/GDM). Safety rests on architecture: scoping, no-trifecta, human-in-the-loop for consequence.
- **Autonomy caveat:** an agent with all three properties gated by human approval can be safer than a two-property agent in full-auto. Approval placement matters more than property counting.
- **Hosted-provider exposure is real but conditional:** API/business data typically not trained on by default, retention windows apply, ZDR is gated. Day One's honest model (E2EE content must decrypt on device before any AI call) is the candor standard.
- **Sensitive slices (therapy, faith, intimate health): personal call, solo.** Not table stakes as it would be for a product. Decision is your risk tolerance vs local-model plumbing and quality. The x-sensitive tag mechanism (below) makes deferral safe: tag now, route later, reversible.

## 7. Model and cost strategy (solo)

- **Tiering:** frontier model for synthesis and cross-domain reasoning; mid/cheap model for routing, extraction, schema-constrained transforms; local embedder (Ollama-class) for pgvector. Standard split, both reports agree.
- **Cost is a non-issue.** Push everything possible through the existing Claude subscription; metered API only for cron agents that cannot ride it. Independent envelopes: $5-30/mo (Claude research) and $16-40/mo (ChatGPT research, at then-current OpenAI rates) with down-tiered routing. Order of magnitude, not a quote.
- **Fine-tuning / distillation: no.** Personal facts change daily; retrieval keeps them updateable, inspectable, revocable. Memory benchmarks show the bottleneck is indexing, retrieval, temporal reasoning, abstention, not memorization. Style-only distillation is the lone theoretical case and a system prompt beats it.

## 8. Pattern library (merged, adopt / adapt / avoid)

1. Bi-temporal fact invalidation, supersede-never-delete (Graphiti/Zep). **Adopt: already have.**
2. Typed objects over generic pages (Capacities, Tana). **Adopt: already have (type_definition).**
3. Services/MCP as the only door (OpenBrain, dbt MCP, Capacities MCP). **Adopt: wrap existing services read-only first.**
4. Semantic-layer grounding, never raw SQL (dbt 2026 benchmark). **Adopt.**
5. Hybrid lexical + vector + rerank (Anthropic contextual retrieval, pgvector guidance). **Adopt.**
6. Embed derived summaries, model-tagged, rebuildable (LongMemEval). **Adopt.**
7. Just-in-time context, tiny always-on core (Anthropic memory tool). **Adopt; hard-code personal core solo.**
8. Compute-then-narrate for aggregates and correlations. **Adopt.**
9. Provenance-cited answers (Zep, Capacities). **Adopt as first-class.**
10. Source receipts on ingestion (raw artifact linked to derived entities). **Adopt.**
11. Ingestion-first capture; calendar > email-enrichment > wearable export > highlights (Reflect, Exist, Oura, Open Wearables). **Adopt.**
12. Sub-minute subjective check-in paired with automatic data (Exist). **Adopt: the surviving exception to "manual capture dies," and the only source of stress/mood signal.**
13. Watch/summarize/remind/draft proactivity (Monica, Exist, Oura, Khoj). **Adopt.**
14. Reminders and review loops over autonomous life management (Monica: "not a smart assistant"). **Adapt.**
15. One visible assistant, hidden scoped specialists (subagents/handoffs). **Adapt.**
16. Graph as implementation detail, not primary UX (Tana, Reflect). **Adopt.**
17. Lethal trifecta / Rule of Two boundary, mechanically enforced (Willison, Meta). **Adopt.**
18. Local-first or explicit-tradeoff handling for sensitive content (Obsidian, Reflect, Day One). **Adapt: x-sensitive tags now, routing when wanted.**
19. Narrow promise, expand by composition (Monica, Oura, Day One, Exist). **Adapt: evidence-first copilot now, Jarvis later.**
20. Framework-agnostic memory bolt-ons (mem0, Letta-as-runtime). **Avoid as dependencies.**
21. Ambient always-on capture as the wedge. **Avoid early.**
22. Becoming a second system of record for tasks/calendar. **Avoid: ingest instead.**

## 9. Ranked roadmap (merged, 12 slices)

Ranking = personal-ROI-per-effort, evidence strength, dependency order. First slices ship in days.

**1. Read-only MCP server + scoped read-only agent token (days).**
Wrap list_types / find / get_entity / history as MCP tools; mint the first narrowed-scopes JWT with it. Zero kernel change; activates the pre-cut seam on day one so scope enforcement is mechanical from agent #1. ROI: grounded ask-my-life answers inside Claude Desktop and every MCP client immediately, before any UI work. (Claude slices 1+7; ChatGPT pattern 7.)

**2. Evidence-first grounded chat with citations (days to a week).**
One SPA page; sidecar agent loop over the MCP read tools; every factual answer cites the entities/events used; structured tool outputs only. ROI: the core copilot experience, hallucination-resistant by construction. (Both reports' consensus slice.)

**3. Calendar ingestion with source receipts (about a week).**
Read-only Google/ICS pull; appointment and attendee types as new type_definition rows; raw source receipt stored and linked; write scope confined to those domains. Email enrichment around events comes later, not now. ROI: the highest-sustained-use domain, and it feeds briefings, prep, and follow-ups. (Both.)

**4. One-minute daily check-in + weekly AI review (days).**
Mood, energy, stress, sleep quality, top priorities, optional one sentence. Weekly summarizer agent reviews it. ROI: supplies the subjective signal no wearable exports reliably (stress, mood), which is the missing input for every signature cross-domain question; Exist proves this exact mix compounds. Doubles as the 14-day capture-sustainability experiment. (ChatGPT slice; conceded gap in Claude roadmap.)

**5. Daily briefing agent, cron, read-only (days; after 3).**
7am: today plus next-24h, overdue items, relevant people context. Draft-and-summarize only. ROI: first proactive Jarvis moment; the single most-cited sustained pattern in the field. (Both.)

**6. Summary projections + hybrid retrieval (about a week; after 3-4 produce data).**
Per-entity, per-day, per-week rolling summaries; embed with local model into the existing table; expose semantic find alongside full-text. Deliberately after ingestion: retrieval infrastructure before data is premature (disagreement resolved against ChatGPT's ordering). ROI: fuzzy recall and timeline summarization without raw-event scans.

**7. Deterministic temporal rollup services (1-2 weeks; after 3, 4, 8 accumulate).**
Query helpers: compare-periods, before/after-event, during-weeks-tagged-X, what-changed, then-vs-now. Model narrates computed results. ROI: unlocks the signature cross-domain correlations ("sleep vs workouts in stressful weeks") with grounded numbers, the thing silo apps cannot do. (ChatGPT slices 5+10 merged; upgrades Claude's retrieval-heavy answer.)

**8. Health/wearable ingestion (about a week).**
Apple Health export.xml (or Oura API) parsed into workout/health entities via capture; time-series lands as events. ROI: high, and only sustainable via import; combined with slice 4 it powers slice 7. (Both.)

**9. Relationship copilot (about a week).**
Extend person: last-touched from events, important dates, reminder entities, drafted-never-auto-sent follow-ups. ROI: Monica's entire surviving value proposition, on data you already model, with low volume. (Both.)

**10. Mobile PWA + Web Share Target + voice-memo quick capture (days to a week).**
Installable SPA over Tailscale; share-sheet destination; dictation to structured entry via a parse-and-capture service. ROI: capture in the flow of life is what makes slices 4 and 9 stick; carry-everywhere with zero new attack surface. (Claude slice enhanced by ChatGPT mechanisms.)

**11. x-sensitive policy tags + sensitive-lane routing (1-2 weeks, when wanted).**
Schema extension beside x-pii: local-only / hosted-allowed / never-external-send / approval-required, consumed by a model router in the sidecar. Solo call: tag types from day one (free), stand up the local lane (Ollama summarizer for therapy/faith/journal types) only when your comfort demands it; the tags make deferral reversible. (ChatGPT's mechanism replaces Claude's config-branch advice; solo framing from prior analysis retained.)

**12. Approval-gated writes and external actions + watcher expansion (a week plus, last).**
Assistant proposes capture/relate/message drafts; SPA approval UI executes. Expand watchers (drift, consistency, commitments) under draft-only until this lands. ROI: the safe path to the third trifecta property, per the autonomy caveat and the injection-bypass evidence. (Both.)

**Explicitly later:** realtime conversational voice; GraphRAG-style expansion over journals; email full ingestion beyond event enrichment; LangGraph-class orchestration. All fine ideas, none load-bearing yet.

**Solo-use adjustments carried forward:** PII erasure is maintenance-only (keep whats built for other-people data in person; do not extend x-pii to new types unless they hold others' info). Hard-code identity spine, family, goals, schedule into the always-on context and briefing prompts; no generic profile machinery. Backups stay sacred; quarterly drill continues. Browse/detail UI polish stays low priority behind chat, forms, and the PWA.

## 10. Architecture deltas (regret-if-skipped)

1. **Sidecar agent runtime now; kernel stays pure.** One visible assistant, hidden scoped specialists. Decide the boundary before writing chat code.
2. **Scoped per-agent tokens plus formal tool/approval classes ship with agent #1** (read-only / draft / remind / external-comms-approval / write-approval). Mechanical, not disciplinary.
3. **Provenance and source receipts first-class on every ingestion and retrieval path.** If the assistant cannot point to the entity/event/receipt behind an answer, trust plateaus early.
4. **Derived summaries and temporal rollups are the retrieval substrate; raw events are truth, never context.** Choose before turning the embedding table on.
5. **x-sensitive policy tags beside x-pii.** Erasure and sensitivity routing are different problems; tag from the first sensitive type even if routing comes later.
6. **Anti-deltas (do NOT make):** second graph substrate, external memory framework as runtime, per-domain APIs or services, second task manager, multi-tenant anything, ambient-capture wedge.

## 11. Open questions and cheapest experiments

1. **Will sub-minute daily capture sustain?** 14-day check-in trial (slice 4 is the experiment). Keep what survives; anything abandoned becomes ingestion-only or gets cut.
2. **Summary vs raw-event embeddings on real questions?** Offline eval: 25-50 hand-written life questions (multi-session recall, temporal reasoning, updates, abstention, per LongMemEval/LoCoMo templates); compare retrieval from raw events vs entity/day/week summaries. Gate slice 6 tuning on it.
3. **Do rollups + hybrid actually ground multi-hop temporal questions?** 20 golden Q&A pairs after slices 6-7; if under ~80%, add graph traversal before more embedding.
4. **How much autonomy feels helpful vs creepy?** Draft-only watcher first (slices 5, 9); promote to approval-gated action only after it earns trust.
5. **Does one unified conversation beat sectioned workflows?** Single cross-domain QA screen (slice 2) while the rest stays sectioned; watch whether cross-domain questions occur naturally before any AI-first UI rewrite.
6. **Does the sensitive lane genuinely need local?** Route one domain (therapy reflections) through a local summarizer for two weeks; compare quality, latency, comfort vs hosted. Empirical, not ideological.
7. **Tool-call-heavy chat latency on a CPX11 over tailnet?** Instrument slice 2; if p95 exceeds ~4s, cache the always-on core and pre-summarize.
8. **Does AccessContext hold for cross-domain merges onto shared entities?** Exercise the documented standing item with the slice-3 ingestion agent; revisit the scope rule then, as planned.

## 12. Caveats

- lifeos repos were not publicly reachable to either research run; the State Report was treated as ground truth and code-level claims were not independently verified.
- Self-reported vendor numbers flagged as such: Anthropic memory-tool (+39%, -84% tokens) and contextual retrieval (67%); Zep vs Mem0 temporal figure is a sub-task comparison, directional only.
- ChatGPT-run-only claims not independently verified: specific OpenAI model tier names and per-token prices; the ambient-capture hardware sunset. Principles carried; specifics flagged.
- Prompt-injection defenses remain unsolved (90-100% adaptive bypass); every safety claim here rests on architectural constraint, not detection.
- Pricing and model landscapes shift monthly; cost figures are order-of-magnitude.
- Convergent-evolution arguments validate the design pattern, not implementation quality.
