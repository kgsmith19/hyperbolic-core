# Research pipeline and durable ledger

`run_search` remains in the secret core: guard → planner → explorer → ranker → synthesis → report. The collector subprocess remains the sole public-network boundary. It never receives a ledger path, manifest, prior evidence ledger, watchlist, or process state.

Each local run has `research_runs/<run-id>/manifest.json`, `events.jsonl`, and `evidence.jsonl`. The manifest is atomically replaced; JSONL is append-only. Only redacted data crosses into these files. `ResearchFrontier.export_state()` persists bounded queues and dedupe/budget state; `from_state()` recreates a fresh lock and requeues stale in-flight work once.

Resume reads local sanitized state, creates a fresh collector pool through the normal explorer path, and retains existing report archives as separate user artifacts.
