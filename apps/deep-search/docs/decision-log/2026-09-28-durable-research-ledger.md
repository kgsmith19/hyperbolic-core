# Durable research ledger decisions

- Use local JSON manifests and JSONL events rather than SQLite: no new dependency, inspectable recovery state.
- Persist sanitized evidence only: durable raw secret-bearing content is prohibited.
- Checkpoint at batch boundaries: aligns with concurrent retrieval and bounds I/O.
- Use deterministic local information gain: reproducible, offline, and no cloud evidence egress.
- Keep `ResearchFrontier`: persistence is an adapter, not a replacement for existing bounds.
- Keep report archives separate: reports are user artifacts; ledgers are execution provenance.
- Defer free-form specialists, external databases, and social/browser acquisition changes.
