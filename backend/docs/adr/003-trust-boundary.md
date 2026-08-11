# ADR 003: Trust boundary — cloud Supabase, single user, no E2E encryption

## Decision
Data lives in a cloud-hosted Supabase Postgres project, accessed by one user
through kernel services with a dedicated database role (`lifeos_app`). No
end-to-end encryption; Supabase (and its infrastructure providers) can
technically read stored data. PII fields are flagged in type schemas
(`x-pii`) so exposure is at least inventoried.

## Consequences
- Massive simplicity win: no key management, search and indexes work
  server-side.
- The database provider is inside the trust boundary — acceptable for a
  personal system, deliberate, and revisitable.
- Credentials stay in the local `.env`, never in the repo.

## Revisit when
The system becomes multi-user, any third-party agent gets access, or PII of
people other than the owner accumulates beyond incidental contact data.
