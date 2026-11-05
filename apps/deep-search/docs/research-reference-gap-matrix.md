# Source-inspected research gap matrix

| Capability | Inspected reference | Deep Search decision |
|---|---|---|
| Durable run state | Hyperresearch `core/runs.py`; lukeswade `storage.py` | Adopt local manifest + JSONL ledger now. |
| Frontier recovery | Existing `ResearchFrontier` | Add export/import; retain all current bounds. |
| Evidence independence | Hyperresearch `independence.py` | Implemented: SimHash 64-bit fingerprints (record-only in frontier) grouped post-rank into families via `backend/research/independence.py`. |
| Citation verification | Hyperresearch `citecheck.py` | Extend existing local verifier later. |
| Contradiction detection | `claim_verifier.verify_evidence` lexical grouping | Implemented: corroboration now counts distinct source-families, not URLs. |
| Durable context | DeerFlow middleware | Persist only sanitized execution state now. |
| Provider routing | GPT Researcher retriever registry | Defer registry work. |
| Specialist agents | Firecrawl sub-agent modules | Defer: model/privacy/cancellation surface is too large. |
| Community sources | lukeswade Reddit/YouTube; last30days adapters | Defer as labeled optional adapters. |

**Update 2026-09-29:** The evidence-independence increment shipped duplicate-family
detection (SimHash families) and family-aware claim verification. Remaining deferred
rows (citation verification depth, provider routing, specialist agents, community
sources) are unchanged.

The supplied DR-Tulu URL returned repository-not-found during the approved source audit; no conclusion is drawn from it.
