"""Type registry: life domains enter the system here as data, never as DDL
(invariant 1)."""

from typing import Any
from uuid import UUID, uuid4

from jsonschema.validators import validator_for
from psycopg.types.json import Jsonb

from kernel import db
from kernel.access import AccessContext, require
from kernel.events import DEFAULT_ACTOR, append_event, iso, tx_now
from kernel.models import TypeDefinition


def define_type(
    ctx: AccessContext,
    name: str,
    domain: str,
    json_schema: dict[str, Any],
    parent: str | None = None,
) -> TypeDefinition:
    require(ctx, f"{domain}:write")
    validator_for(json_schema).check_schema(json_schema)
    for key in ("x-identity", "x-pii"):
        value = json_schema.get(key)
        if value is not None and (
            not isinstance(value, list) or not all(isinstance(f, str) for f in value)
        ):
            raise ValueError(f"{key} must be a list of field names")

    with db.connect() as conn:
        parent_id: UUID | None = None
        if parent is not None:
            parent_row = conn.execute(
                "select id from type_definition where name = %s", (parent,)
            ).fetchone()
            if parent_row is None:
                raise LookupError(f"unknown parent type: {parent}")
            parent_id = parent_row["id"]
        now = tx_now(conn)
        type_id = uuid4()
        conn.execute(
            """
            insert into type_definition (id, name, domain, json_schema, parent_type_id,
                                         is_active, created_at)
            values (%s, %s, %s, %s, %s, true, %s)
            """,
            (type_id, name, domain, Jsonb(json_schema), parent_id, now),
        )
        append_event(
            conn,
            entity_id=None,
            event_type="type.defined",
            payload={
                "type": {
                    "id": str(type_id),
                    "name": name,
                    "domain": domain,
                    "json_schema": json_schema,
                    "parent_type_id": str(parent_id) if parent_id else None,
                    "is_active": True,
                    "created_at": iso(now),
                }
            },
            valid_time=now,
            recorded_at=now,
            actor=DEFAULT_ACTOR,
        )
        return TypeDefinition(
            id=type_id,
            name=name,
            domain=domain,
            json_schema=json_schema,
            parent_type_id=parent_id,
            is_active=True,
            created_at=now,
        )
