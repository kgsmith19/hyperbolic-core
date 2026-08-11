# ADR 002: Generic kernel + type registry as data; domains never touch DDL

## Decision
The kernel schema is seven tables and knows nothing about life domains. A
domain (health, finance, relationships…) enters as `type_definition` rows —
a name, a domain string, and a JSON Schema with `x-identity`/`x-pii`
extensions — plus optional code under `src/domains/<name>/`. Entities hold
attributes as JSONB and can carry multiple types (composition, the Tana
supertag move). Migration 0001 is the only kernel DDL.

## Consequences
- Adding a domain is a data operation: zero migrations (proven by test).
- No per-domain columns or tables, ever; hot JSONB paths get expression
  indexes only when a query proves hot.
- Typed richness lives in JSON Schema validation, not the type system of SQL.

## Revisit when
A domain genuinely cannot express itself as typed JSONB + edges + events, and
the pressure point is documented as a change request per invariant 1.
