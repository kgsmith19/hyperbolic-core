# Evidence Independence and Family-Aware Verification Design

## Purpose

Deep Search already collects, ranks, and verifies evidence, but it treats each
retrieved URL as an independent source. Syndicated and near-duplicate documents —
one wire story republished by five outlets, a preprint and its published twin, a
press release quoted verbatim — currently inflate apparent corroboration: the claim
verifier calls a claim "corroborated" when it appears in two URLs even when those two
URLs are the same underlying source.

This increment adds, additively and locally:

1. **Evidence independence.** A deterministic near-duplicate fingerprint (SimHash) is
   computed at collection time and used, after ranking, to group evidence into
   *families* of substantially-the-same content.
2. **Family-aware verification.** Corroboration is counted by distinct families, not
   URLs, so five copies of one story count as one independent source.
3. **An independence surface.** The report gains an Independence section and the
   pre-run preview gains a warning describing the behavior.

The design is additive. It does not change the collector process, socket air gap,
priority frontier resource budgets, connector set, ranking stack order, or local
fallback synthesis. It is the "evidence-quality increment" deferred by
`docs/superpowers/specs/2026-09-28-durable-research-ledger-design.md` and its gap
matrix (rows: *Contradiction detection — extend rather than replace*,
*Duplicate-family analysis — add source-family records in evidence-quality
increment*).

## Evidence Basis

Based on direct inspection of the current repository, not descriptions.

- `backend/frontier/priority_frontier.py::ResearchFrontier.record_document` already
  normalizes text (`" ".join(text.split()).lower()`) and stores an exact SHA-256
  `content_hash`; exact duplicates are dropped there. Near-duplicates survive as
  separate `Evidence`. `export_state`/`from_state` serialize frontier state for the
  durable ledger and must continue to round-trip.
- `backend/research/types.py::Evidence` is a frozen dataclass with `title, url,
  snippet, excerpt, doi, depth, source, score, rerank_score`. `SearchOptions` holds
  independent additive knobs.
- `backend/research/research_pipeline.py::run_search` runs
  `explore → rank_items → (optional) rerank_candidates → _synthesize → write_report`.
  `_synthesize` optionally calls `claim_verifier.verify_evidence` when
  `options.claim_verification` and passes the result to `summarize_with_openai`.
- `backend/synthesis/claim_verifier.py::verify_evidence` groups claims by an
  entity/number key and classifies `verified` (≥2 distinct URLs), `contested`
  (mixed negation), and `single_source` (one URL). `verification_brief` renders a
  prompt block. `backend/synthesis/openai_synthesizer.py` injects that block.
- `backend/synthesis/report_generator.py::write_report` renders Executive Summary and
  a numbered Evidence & Sources list, redacting every field.
- `backend/research/preview.py::preview` builds outcome-phrased warnings gated on
  option flags.
- Reference (inspected earlier during the ledger audit): Hyperresearch
  `core/independence.py::compute_independence` computes source-independence families
  separately from report generation; lukeswade `app/research/dedupe.py` combines
  content fingerprints with per-domain limits. This increment follows that
  separation: fingerprints are recorded during collection; family grouping is a
  distinct post-ranking analysis step.

## Current Strengths That Must Remain

1. **Zero-secret-egress.** SimHash and family metadata are computed only in the secret
   core over already-sanitized text/Evidence. No new value reaches the collector, and
   every ledger write stays sanitized through the existing `_sanitize` path.
2. **Frontier budget authority.** `record_document` keeps its exact-hash dedup and its
   byte/document/domain accounting byte-for-byte. The SimHash is recorded only; it
   never drops or reweights a candidate. Budgets mean exactly what they mean today.
3. **Additive types and options.** `Evidence` and `ResearchRun` gain defaulted fields;
   old construction sites, payloads, and the durable ledger keep working.
4. **Local-first, no-egress default.** Family grouping and family-aware verification
   are pure local computation; the no-API-key path is unaffected.
5. **Cancellation, ledger, report archives, CLI/server compatibility** remain intact.

## Architecture

### Data flow

```
explore
  → rank_items(topic, evidence)
  → (optional) rerank_candidates
  → assign_families(ranked)           # NEW: annotate family_id + representative
  → verify_evidence(dicts, families)  # EXTENDED: corroboration by family
  → _synthesize(...)                  # prompt block already family-aware via verification
  → write_report(..., independence=...)# NEW: Independence section
```

Family assignment runs once, post-rank/post-rerank, so verification, synthesis, and
the report all consume the same family assignment. It is a pure function over the
already-ranked, already-sanitized `Evidence` list.

### Component 1 — Frontier fingerprint (record-only)

`ResearchFrontier.__init__` gains `self.content_simhashes: dict[str, int] = {}`
(url → 64-bit signature). `record_document(url, content_bytes, text, doi)` computes
the SimHash of the same `norm_text` it already builds and stores it keyed by URL —
*after* the existing exact-hash dedup decision and only when the document is accepted.
It does not change the return value, the dedup outcome, or any budget counter.

`export_state` adds `"content_simhashes": dict(self.content_simhashes)` (JSON-safe:
str→int). `from_state` restores it, tolerating its absence (older snapshots) by
defaulting to `{}`. Required-field validation is unchanged; the new field is optional
on import for backward compatibility with in-flight ledgers.

The explorer, which constructs `Evidence` from collected documents, reads
`frontier.content_simhashes.get(url, 0)` and passes it as `Evidence.simhash`.

### Component 2 — SimHash primitive

New `backend/research/independence.py` (pure, no imports from retrieval):

```python
SHINGLE_SIZE = 3        # words per shingle
SIMHASH_BITS = 64
HAMMING_THRESHOLD = 3   # <= means same family

def simhash(text: str) -> int
def hamming(a: int, b: int) -> int
```

`simhash` lowercases and whitespace-normalizes (matching the frontier's `norm_text`
recipe so a document's frontier fingerprint equals its recomputed fingerprint),
splits into words, forms overlapping 3-word shingles, hashes each shingle with a
stable algorithm — `hashlib.blake2b(shingle.encode(), digest_size=8)` reduced to a
64-bit int (deterministic across processes and Python runs, unlike the salted builtin
`hash`) — and folds shingle hashes into a 64-bit signature by the standard SimHash
bit-vote. Empty/whitespace text returns `0`. A document shorter than one shingle
hashes its single available token so short snippets still get a stable non-degenerate
signature.

### Component 3 — Family assignment

```python
@dataclass(frozen=True)
class Family:
    family_id: int
    representative_url: str
    member_urls: tuple[str, ...]
    size: int

def assign_families(evidence: list[Evidence]) -> tuple[list[Evidence], list[Family]]
```

Deterministic union-find over the ranked list, in list order (so results are stable
and ranking-independent of dict ordering):

1. **SimHash near-duplicate.** For each ordered pair, union when both signatures are
   non-zero and `hamming(a, b) <= HAMMING_THRESHOLD`.
2. **Same DOI.** Union any two items sharing a non-empty normalized DOI (a preprint and
   its published version frequently share a DOI or a DOI stem).
3. **Domain + title tiebreak.** Union two items on the same registrable domain whose
   normalized titles have Jaccard token overlap ≥ 0.9 (catches near-identical
   re-posts whose bodies differ in boilerplate enough to exceed the Hamming
   threshold). This is a conservative last resort, not the primary signal.

The **representative** of a family is its highest-ranked member (first in the
already-ranked input; ranking placed the strongest source first). Each returned
`Evidence` copy carries `family_id` (0-based, assigned in first-appearance order) and
`is_representative`. `Family` records are ordered by representative rank.

Complexity is O(n²) pairwise; n is bounded by `rerank_keep` (default 12) and, before
rerank, by `max_documents`, so this is trivially cheap and needs no blocking index.

### Component 4 — Family-aware verification

`claim_verifier.verify_evidence(evidence, max_claims_per_doc=6, families=None)` gains
an optional `families` argument mapping url → family_id. When supplied:

- Corroboration counts **distinct family_ids**, not URLs. A claim is `verified` only
  when its key appears in ≥2 distinct families without negation divergence.
- `single_source` covers a key seen in exactly one family (even if several URLs).
- `contested` retains its negation-divergence rule but is likewise computed over
  family-distinct occurrences.
- Each result item gains `families: [id, ...]` alongside its existing `urls`.

When `families is None`, behavior is exactly today's URL-based logic (full backward
compatibility; existing tests unaffected).

`verify_evidence` also returns an additive `independence` summary:
`{"families": <count>, "collapsed_claims": <n>}` where `collapsed_claims` counts
claims that had ≥2 URLs but only 1 family — i.e. apparent corroboration that
independence analysis revealed as a single source. This summary drives the report and
a progress message.

### Component 5 — Report and preview surface

`report_generator.write_report(..., independence: dict | None = None)`: when supplied
and it reports more than one source-family or any collapsed claims, render an
`## Independence` section after Executive Summary listing family count, largest family
size, and a short line per multi-member family (representative title + member count),
all redacted. When `independence is None` (old callers), the report is byte-identical
to today.

`preview.py`: a new `claim_verification`-gated warning, e.g.
`WARN_INDEPENDENCE = "near-duplicate and syndicated sources grouped into families; corroboration counts independent families, not copies"`,
appended when `options.claim_verification` is on (independence rides the existing
verification switch — no new option knob, since it is a correctness improvement to a
feature already on by default).

### Pipeline wiring

In `research_pipeline.py`, after ranking/rerank and before `_synthesize`, call
`assign_families(ranked)`; the annotated list replaces `ranked` for synthesis,
verification, report, and the returned `ResearchRun.evidence`. `_synthesize` builds a
`url → family_id` map from the annotated evidence and passes `families=` and receives
the `independence` summary, which flows to `write_report`. A progress message reports
collapsed corroboration when `collapsed_claims > 0`. Family assignment is wrapped so
any unexpected failure degrades gracefully to today's behavior (empty families,
URL-based verification) rather than failing the run.

### Types

`Evidence` gains `simhash: int = 0` and `family_id: int = -1` and
`is_representative: bool = False` (all defaulted, appended). `hybrid_ranker` and the
pipeline's `_evidence_as_dicts`/`_dicts_as_evidence` helpers thread the new fields
through when present, defaulting when absent, so ranking, rerank, and the ledger
round-trip preserve them without requiring them.

## Error Handling

- SimHash of empty/degenerate text returns `0`; a `0` signature never participates in
  Hamming-based unioning (only DOI/domain rules can group it), avoiding false
  families among content-less items.
- `assign_families` on an empty list returns `([], [])`.
- Malformed/absent `content_simhashes` in a restored ledger defaults to `{}`; a run
  resumed from an older snapshot simply recomputes signatures for newly collected docs
  and treats prior-evidence signatures as `0` (grouping falls back to DOI/domain for
  those) — correctness degrades gracefully, never crashes.
- The pipeline family step is defensive: exceptions log-and-continue with no families,
  preserving the run.
- All family/independence data is sanitized by the existing ledger `_sanitize` path
  before any persistence; the SimHash is an integer and carries no text.

## Testing

New `test_evidence_independence.py`, offline, deterministic:

- **SimHash primitive:** identical text → identical signature; whitespace/case variants
  → identical; near-duplicate (one sentence changed) → Hamming ≤ threshold; unrelated
  text → Hamming ≫ threshold; empty → 0; determinism across calls.
- **Frontier record-only:** `record_document` stores a signature for an accepted doc,
  stores nothing for a rejected exact-duplicate, and leaves `documents_collected`,
  `total_bytes_consumed`, and dedup return values identical to a run without the
  feature. `export_state`/`from_state` round-trip `content_simhashes`; a state dict
  lacking the key restores to `{}`.
- **Family assignment:** five near-duplicate wire copies collapse to one family with the
  highest-ranked as representative; a shared DOI groups a preprint+published pair; two
  unrelated docs stay in separate families; representative is the top-ranked member;
  ids assigned in first-appearance order; empty input → empty output.
- **Family-aware verification:** a claim appearing in 5 URLs across 1 family is
  `single_source`, not `verified`; the same claim across 2 families is `verified`;
  `collapsed_claims` counts the collapse; `families=None` reproduces today's URL-based
  verdicts exactly (regression pin).
- **Report/preview:** `write_report(independence=...)` emits an Independence section with
  no watchlist leakage; `write_report(independence=None)` is byte-identical to the
  pre-change output; preview includes the independence warning iff
  `claim_verification` is on.
- **Pipeline integration:** an offline fake-collector run that returns near-duplicate
  documents produces `ResearchRun.evidence` carrying `family_id`, a report with an
  Independence section, and family-collapsed verification, with all existing suites
  still green.

Required full verification command (must be green before merge):

```
python -m unittest test_safe_research.py test_bounded_contexts.py \
  test_ai_search_expansion.py test_deep_expansion.py test_ultra_deep.py \
  test_server_stream.py test_durable_research_ledger.py test_evidence_independence.py
```

## Out of Scope

- Frontier down-weighting or dropping on near-match (recorded fingerprint only).
- New user-facing option knob (independence rides `claim_verification`).
- Cross-run / persistent family memory beyond the existing per-run ledger.
- Model-based independence or embedding-based clustering (deterministic local only).
- Evidence-quality/authority scoring (venue, primary-vs-secondary) — a later increment.
