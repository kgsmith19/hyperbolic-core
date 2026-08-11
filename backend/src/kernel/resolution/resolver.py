"""Entity resolution. V1 is exact identity-field matching; anything fuzzier is
out of scope until a real need lands."""

import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol
from uuid import UUID

from kernel.db import Connection
from kernel.models import TypeDefinition


class Resolution(StrEnum):
    NEW = "new"
    MATCH = "match"
    AMBIGUOUS = "ambiguous"


@dataclass(frozen=True)
class ResolveResult:
    resolution: Resolution
    entity_id: UUID | None = None
    candidates: tuple[UUID, ...] = ()


class EntityResolver(Protocol):
    def resolve(
        self, conn: Connection, type_def: TypeDefinition, attributes: dict[str, Any]
    ) -> ResolveResult: ...


class ExactIdentityResolver:
    """Exact match on the type's x-identity fields, against entities of any type
    sharing the identity field. Array-valued fields match on element overlap.
    No identity fields declared -> always NEW."""

    def resolve(
        self, conn: Connection, type_def: TypeDefinition, attributes: dict[str, Any]
    ) -> ResolveResult:
        identity_fields = type_def.identity_fields
        if not identity_fields:
            return ResolveResult(Resolution.NEW)

        matches: set[UUID] = set()
        for field in identity_fields:
            value = attributes.get(field)
            if value is None:
                continue
            elements = value if isinstance(value, list) else [value]
            conditions: list[str] = []
            params: list[Any] = [field]
            for element in elements:
                # stored as array: attributes->field contains [element]
                conditions.append("e.attributes -> %s @> %s::jsonb")
                params.extend([field, json.dumps([element])])
                # stored as scalar: attributes contains {field: element}
                conditions.append("e.attributes @> %s::jsonb")
                params.append(json.dumps({field: element}))
            if not conditions:
                continue
            rows = conn.execute(
                f"""
                select distinct e.id
                from entity e
                join entity_type et on et.entity_id = e.id
                join type_definition td on td.id = et.type_id
                where td.json_schema -> 'x-identity' ? %s
                  and ({" or ".join(conditions)})
                """,
                params,
            ).fetchall()
            matches.update(row["id"] for row in rows)

        if not matches:
            return ResolveResult(Resolution.NEW)
        if len(matches) == 1:
            return ResolveResult(Resolution.MATCH, entity_id=next(iter(matches)))
        return ResolveResult(Resolution.AMBIGUOUS, candidates=tuple(sorted(matches, key=str)))
