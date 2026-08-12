# ADR 004: Embeddings are derived, model-tagged, rebuildable; pgvector reserved

## Decision
The `embedding` table exists (entity_id, model, dim, vector) with pgvector
enabled, and is empty. Embeddings are derived indexes over entities — never
source of truth — and every row is tagged with the model that produced it, so
a model swap is a re-embed job, not a migration. Nothing may depend on a
specific embedding model.

## Consequences
- Semantic search can be added later without schema changes.
- Crude tsvector search carries v1; that is fine.
- Rebuild wipes embeddings with the other projections; they regenerate.

## Revisit when
An embedding job actually lands (then: choose model, backfill, add ANN index),
or vector search needs per-type spaces rather than one table.
