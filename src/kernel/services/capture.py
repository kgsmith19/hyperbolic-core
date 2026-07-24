"""The write path: validate -> resolve -> event -> projection, one transaction."""

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from jsonschema import validate
from pydantic import BaseModel

from kernel import db
from kernel.access import AccessContext, require
from kernel.events import DEFAULT_ACTOR, append_event, iso, tx_now
from kernel.projections import apply_event
from kernel.resolution import EntityResolver, ExactIdentityResolver, Resolution
from kernel.services.common import entity_type_names, load_type

_default_resolver = ExactIdentityResolver()


class CaptureResult(BaseModel):
    entity_id: UUID
    resolution: Resolution


def capture(
    ctx: AccessContext,
    type_name: str,
    attributes: dict[str, Any],
    valid_time: datetime | None = None,
    actor: str = DEFAULT_ACTOR,
    resolver: EntityResolver | None = None,
) -> CaptureResult:
    resolver = resolver or _default_resolver
    with db.connect() as conn:
        type_def = load_type(conn, type_name)
        require(ctx, f"{type_def.domain}:write")
        validate(instance=attributes, schema=type_def.json_schema)

        result = resolver.resolve(conn, type_def, attributes)
        conn.execute("set constraints all deferred")
        now = tx_now(conn)
        when = valid_time or now

        if result.resolution is Resolution.MATCH:
            assert result.entity_id is not None
            entity_id = result.entity_id
            existing = conn.execute(
                "select attributes, created_at from entity where id = %s", (entity_id,)
            ).fetchone()
            assert existing is not None
            merged: dict[str, Any] = {**existing["attributes"], **attributes}
            created_at: datetime = existing["created_at"]
            event_type = "entity.updated"
            types = sorted(set(entity_type_names(conn, entity_id)) | {type_def.name})
        else:
            entity_id = uuid4()
            merged = attributes
            created_at = now
            event_type = "entity.created"
            types = [type_def.name]

        name = merged.get("name") if isinstance(merged.get("name"), str) else None
        payload = {
            "entity": {
                "id": str(entity_id),
                "name": name,
                "attributes": merged,
                "created_at": iso(created_at),
                "updated_at": iso(now),
            },
            "types": types,
        }
        append_event(
            conn,
            entity_id=entity_id,
            event_type=event_type,
            payload=payload,
            valid_time=when,
            recorded_at=now,
            actor=actor,
        )
        apply_event(conn, event_type, payload)

        if result.resolution is Resolution.AMBIGUOUS:
            append_event(
                conn,
                entity_id=entity_id,
                event_type="resolution.ambiguity",
                payload={
                    "type_name": type_name,
                    "attributes": attributes,
                    "candidates": [str(c) for c in result.candidates],
                },
                valid_time=when,
                recorded_at=now,
                actor=actor,
            )
        return CaptureResult(entity_id=entity_id, resolution=result.resolution)
