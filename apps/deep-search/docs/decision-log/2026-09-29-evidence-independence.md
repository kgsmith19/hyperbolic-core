# Evidence independence decisions

- **SimHash over MinHash/embeddings:** one compact 64-bit signature per document, O(1) storage, cheap pairwise Hamming; deterministic and offline. MinHash needs many hashes per doc; embeddings add a model and are non-deterministic. Independence must be reproducible for the ledger and zero-egress.
- **`blake2b` shingle hashing, never the builtin `hash`:** Python's `hash` is salted per-process; `blake2b(digest_size=8)` gives stable signatures across processes and runs, which the ledger and tests depend on.
- **Record-only in the frontier:** `record_document` stores a fingerprint after the existing exact-SHA-256 dedup decision and never drops or reweights on near-match. Byte/document/domain budgets keep their exact meaning; independence is purely an analysis concern.
- **Families computed once, post-rank:** a single `assign_families` pass over the ranked (and reranked) evidence produces one family assignment shared by verification, synthesis, and the report. No recomputation, no per-consumer drift.
- **`HAMMING_THRESHOLD = 12`, not the textbook 3:** measured empirically on realistic evidence excerpts — verbatim syndication separates at ~9 bits, reworded copies at ~23, unrelated at 31+. The classic threshold of 3 assumes very large documents with hundreds of shingles; short excerpts need a higher cut. DOI and domain+title tiebreaks catch heavier rewording that SimHash alone misses.
- **Corroboration counted by distinct families, not URLs:** five copies of one wire story are one independent source. `verify_evidence(families=None)` preserves the original URL-based behavior exactly for any caller that does not supply families.
- **Independence rides `claim_verification` — no new option knob:** it is a correctness improvement to a feature already on by default, not an independent tradeoff, so it needs no separate confirm/preview gate beyond the existing verification warning plus one independence line.
- **Graceful degradation:** family assignment is wrapped so any failure falls back to no families and URL-based verification; a run always completes. A resumed ledger snapshot lacking `content_simhashes` restores to `{}` and recomputes signatures for newly collected docs.

## Rejected alternatives
- Dropping near-duplicates in the frontier (changes budget semantics; the report could no longer show "this story appeared in N outlets").
- A new `SearchOptions` knob for independence (adds a tradeoff surface for what is a bug fix to corroboration counting).
- Embedding/model-based clustering (non-deterministic, potential egress, heavier).
