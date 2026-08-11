# ADR 005: Scope-shaped access, separate from containment, enforced from day one

## Decision
Access control is a flat set of scope strings `<domain>:<read|write>` where
domain comes from `type_definition.domain` — deliberately not a folder tree or
entity hierarchy. Every kernel service takes an AccessContext and calls
`require()`; the single-user default context holds all scopes but the check
still executes on every call. The API layer is where contexts are built.

## Consequences
- Future agent scoping (least-privilege seams for an orchestrator) bolts on
  by constructing narrower contexts — zero kernel rework, proven by test.
- Cross-domain operations (edges) require write on both endpoints' domains.
- Scope checks cost one set-lookup per call; negligible.

## Revisit when
Scopes need finer grain than domain level (per-type, per-entity), or a real
second principal (human or agent) appears.
