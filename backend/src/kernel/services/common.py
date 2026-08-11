"""Shared lookups used across services. Internal to the kernel."""

from uuid import UUID

from kernel.db import Connection
from kernel.models import Entity, TypeDefinition


def load_type(conn: Connection, name: str) -> TypeDefinition:
    row = conn.execute(
        "select * from type_definition where name = %s and is_active", (name,)
    ).fetchone()
    if row is None:
        raise LookupError(f"unknown type: {name}")
    return TypeDefinition.model_validate(row)


def load_entity(conn: Connection, entity_id: UUID) -> Entity:
    row = conn.execute(
        "select id, name, attributes, created_at, updated_at from entity where id = %s",
        (entity_id,),
    ).fetchone()
    if row is None:
        raise LookupError(f"unknown entity: {entity_id}")
    return Entity.model_validate(row)


def entity_type_names(conn: Connection, entity_id: UUID) -> list[str]:
    rows = conn.execute(
        """
        select td.name from entity_type et
        join type_definition td on td.id = et.type_id
        where et.entity_id = %s order by td.name
        """,
        (entity_id,),
    ).fetchall()
    return [row["name"] for row in rows]


def entity_domains(conn: Connection, entity_id: UUID) -> set[str]:
    rows = conn.execute(
        """
        select distinct td.domain from entity_type et
        join type_definition td on td.id = et.type_id
        where et.entity_id = %s
        """,
        (entity_id,),
    ).fetchall()
    return {row["domain"] for row in rows}
