"""Request DTOs. Responses reuse kernel models directly — the API adds nothing."""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel

from kernel.events import DEFAULT_ACTOR


class DefineTypeIn(BaseModel):
    name: str
    domain: str
    json_schema: dict[str, Any]
    parent: str | None = None


class CaptureIn(BaseModel):
    type_name: str
    attributes: dict[str, Any]
    valid_time: datetime | None = None
    actor: str = DEFAULT_ACTOR


class RelateIn(BaseModel):
    from_id: UUID
    relation: str
    to_id: UUID
    valid_from: datetime
    attributes: dict[str, Any] | None = None


class ForgetIn(BaseModel):
    """`fields=None` erases every x-pii field the entity's types declare."""

    fields: list[str] | None = None
    actor: str = DEFAULT_ACTOR
