# Source-inspected research gap matrix

| Capability | Inspected reference | Deep Search decision |
|---|---|---|
| Durable run state | Hyperresearch `core/runs.py`; lukeswade `storage.py` | Adopt local manifest + JSONL ledger now. |
| Frontier recovery | Existing `ResearchFrontier` | Add export/import; retain all current bounds. |
| Evidence independence | Hyperresearch `independence.py` | Defer to evidence-quality increment. |
| Citation verification | Hyperresearch `citecheck.py` | Extend existing local verifier later. |
| Durable context | DeerFlow middleware | Persist only sanitized execution state now. |
| Provider routing | GPT Researcher retriever registry | Defer registry work. |
| Specialist agents | Firecrawl sub-agent modules | Defer: model/privacy/cancellation surface is too large. |
| Community sources | lukeswade Reddit/YouTube; last30days adapters | Defer as labeled optional adapters. |

The supplied DR-Tulu URL returned repository-not-found during the approved source audit; no conclusion is drawn from it.
