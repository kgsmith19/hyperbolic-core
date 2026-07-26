"""The read path. Scope checks run on every call (invariant 5)."""

from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from kernel import db
from kernel.access import AccessContext, ScopeError, require
from kernel.models import Edge, Entity, EntityView, Event
from kernel.services.common import entity_domains, entity_type_names, load_entity, load_type


def _readable(ctx: AccessContext, domains: set[str]) -> bool:
    try:
        for domain in domains:
            require(ctx, f"{domain}:read")
    except ScopeError:
        return False
    return True


def get_entity(ctx: AccessContext, entity_id: UUID) -> EntityView:
    with db.connect() as conn:
        entity = load_entity(conn, entity_id)
        for domain in sorted(entity_domains(conn, entity_id)):
            require(ctx, f"{domain}:read")
        types = entity_type_names(conn, entity_id)
        active = "valid_to is null and superseded_at is null"
        out_rows = conn.execute(
            f"select * from edge where from_entity = %s and {active} order by recorded_at",
            (entity_id,),
        ).fetchall()
        in_rows = conn.execute(
            f"select * from edge where to_entity = %s and {active} order by recorded_at",
            (entity_id,),
        ).fetchall()
        return EntityView(
            entity=entity,
            types=types,
            edges_out=[Edge.model_validate(r) for r in out_rows],
            edges_in=[Edge.model_validate(r) for r in in_rows],
        )


def find(
    ctx: AccessContext,
    type_name: str | None = None,
    filters: dict[str, Any] | None = None,
    text: str | None = None,
) -> list[Entity]:
    with db.connect() as conn:
        clauses: list[str] = []
        params: list[Any] = []
        if type_name is not None:
            type_def = load_type(conn, type_name)
            require(ctx, f"{type_def.domain}:read")
            clauses.append("e.id in (select entity_id from entity_type where type_id = %s)")
            params.append(type_def.id)
        if filters:
            clauses.append("e.attributes @> %s")
            params.append(Jsonb(filters))
        if text is not None:
            clauses.append("e.search @@ plainto_tsquery('simple', %s)")
            params.append(text)
        where = f" where {' and '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            "select e.id, e.name, e.attributes, e.created_at, e.updated_at "
            f"from entity e{where} order by e.created_at",
            params,
        ).fetchall()
        entities = [Entity.model_validate(r) for r in rows]
        if type_name is None:
            entities = [
                e for e in entities if _readable(ctx, entity_domains(conn, e.id))
            ]
        return entities


def ping() -> bool:
    """Liveness for health checks: the database answers. Touches no data,
    so it is the one service without an AccessContext."""
    with db.connect() as conn:
        conn.execute("select 1")
    return True


def history(ctx: AccessContext, entity_id: UUID) -> list[Event]:
    with db.connect() as conn:
        load_entity(conn, entity_id)
        for domain in sorted(entity_domains(conn, entity_id)):
            require(ctx, f"{domain}:read")
        rows = conn.execute(
            "select * from event where entity_id = %s order by recorded_at, id",
            (entity_id,),
        ).fetchall()
        return [Event.model_validate(r) for r in rows]
