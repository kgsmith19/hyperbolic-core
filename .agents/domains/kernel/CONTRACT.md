# Kernel contract

Public surface = application services in `src/kernel/services/`; import from
`kernel.services`. Every call takes an AccessContext first and passes through
`require()` (invariant 5). Nothing outside the kernel touches tables (invariant 7).

- `define_type(ctx, name, domain, json_schema, parent=None) -> TypeDefinition`
- `capture(ctx, type_name, attributes, valid_time=None, actor="kyle", resolver=None) -> CaptureResult`
- `relate(ctx, from_id, relation, to_id, valid_from, attributes=None, actor="kyle") -> Edge`
- `supersede_edge(ctx, edge_id, valid_to, actor="kyle") -> Edge`
- `get_entity(ctx, entity_id) -> EntityView`
- `find(ctx, type_name=None, filters=None, text=None) -> list[Entity]`
- `history(ctx, entity_id) -> list[Event]`
- `ping() -> bool` — health checks only; touches no data, the one call without an AccessContext

Errors: `kernel.access.ScopeError` (missing scope), `LookupError` (unknown
type/entity/edge), `jsonschema.SchemaError` / `jsonschema.ValidationError`
(invalid schema / attributes), `ValueError` (bad x-identity/x-pii, double supersede).
