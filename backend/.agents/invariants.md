# lifeos invariants

1. The kernel is domain-agnostic. Domains NEVER add tables or columns to kernel
   tables. A new domain = type_definition rows + optional module under
   `src/domains/<name>/`. If a domain feature seems to require kernel DDL:
   stop and write a change request instead of proceeding.
2. Events are append-only and are the source of truth. Entity and edge state
   are rebuildable projections. Never UPDATE or DELETE an event row.
3. Facts are bi-temporal: valid time (world) and recorded time (system).
   Supersede, never overwrite.
4. One identity spine. A person or thing exists once as a kernel entity;
   domains reference it by id. No domain-private person/contact tables.
5. Access control is scope-shaped (`<domain>:<read|write>`) and separate from
   any containment hierarchy. Every service call carries an AccessContext,
   even while single-user, so agent scoping bolts on later without rework.
6. Embeddings and search indexes are derived, model-tagged, and rebuildable.
   Never source of truth. Nothing may depend on a specific embedding model.
7. AI and agents touch the system only through application services (future
   MCP servers wrap services). Never raw tables, never raw SQL.
8. No single component may combine (a) broad read access, (b) external
   communication, and (c) high-consequence writes. Any future agent feature
   must name which leg it lacks before design review passes.
9. Every PII field is flagged in its type schema and must have a working
   deletion path. Append-only does not exempt us from erasure.
10. A life domain gets its own `.agents/domains/<name>/` cell when its
    `src/domains/<name>/` module lands.
