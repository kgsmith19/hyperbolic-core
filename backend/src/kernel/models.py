"""Kernel models. These mirror kernel tables exactly — no domain fields ever."""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel


class TypeDefinition(BaseModel):
    id: UUID
    name: str
    domain: str
    json_schema: dict[str, Any]
    parent_type_id: UUID | None = None
    is_active: bool = True
    created_at: datetime

    @property
    def identity_fields(self) -> list[str]:
        fields = self.json_schema.get("x-identity", [])
        return list(fields) if isinstance(fields, list) else []

    @property
    def pii_fields(self) -> list[str]:
        fields = self.json_schema.get("x-pii", [])
        return list(fields) if isinstance(fields, list) else []


class Entity(BaseModel):
    id: UUID
    name: str | None = None
    attributes: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class Edge(BaseModel):
    id: UUID
    from_entity: UUID
    relation: str
    to_entity: UUID
    attributes: dict[str, Any]
    valid_from: datetime
    valid_to: datetime | None = None
    recorded_at: datetime
    superseded_at: datetime | None = None


class Event(BaseModel):
    id: UUID
    entity_id: UUID | None = None
    event_type: str
    payload: dict[str, Any]
    valid_time: datetime
    recorded_at: datetime
    actor: str


class EntityView(BaseModel):
    entity: Entity
    types: list[str]
    edges_out: list[Edge]
    edges_in: list[Edge]
