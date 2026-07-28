# Kernel contract

Public surface = application services in `src/kernel/services/`; import from
`kernel.services`. Every call takes an AccessContext first and passes through
`require()` (invariant 5). Nothing outside the kernel touches tables (invariant 7).

- `define_type(ctx, name, domain, json_schema, parent=None) -> TypeDefinition`
- `list_types(ctx) -> list[TypeDefinition]` — active types in domains ctx can read
- `capture(ctx, type_name, attributes, valid_time=None, actor="kyle", resolver=None) -> CaptureResult`
  — requires write on the captured type's domain only, even when resolution
  merges onto a shared multi-domain entity (revisit when agent scopes land)
- `relate(ctx, from_id, relation, to_id, valid_from, attributes=None, actor="kyle") -> Edge`
- `supersede_edge(ctx, edge_id, valid_to, actor="kyle") -> Edge`
- `get_entity(ctx, entity_id) -> EntityView`
- `find(ctx, type_name=None, filters=None, text=None) -> list[Entity]` — returns
  only entities every domain of which ctx can read (same rule as `get_entity`)
- `history(ctx, entity_id) -> list[Event]`
- `forget(ctx, entity_id, fields=None, actor="kyle") -> ForgetResult` — erasure by
  redaction (invariant 9, ADR 007); `fields=None` means every `x-pii` field the
  entity's types declare. Needs write on every domain the entity belongs to.
- `ping() -> bool` — health checks only; touches no data, the one call without an AccessContext

Errors: `kernel.access.ScopeError` (missing scope), `LookupError` (unknown
type/entity/edge), `jsonschema.SchemaError` / `jsonschema.ValidationError`
(invalid schema / attributes), `ValueError` (duplicate type name, bad
x-identity/x-pii, double supersede, forget on a non-PII field or an entity
with no PII flags). The API maps ValueError and both jsonschema errors to 422.
