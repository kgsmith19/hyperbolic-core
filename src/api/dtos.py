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


class ApproveIn(BaseModel):
    """Approving a proposal means approving one exact draft (ADR 018).

    `draft_digest` is the sha256 the caller was shown, echoed back. It is
    required, so an approval cannot be issued by anything that has not read the
    draft, and a draft whose facts moved in between is refused rather than
    approved on the strength of text nobody saw. `granted_by` is deliberately
    NOT here: who approved comes from the verified request, never from the body.
    """

    draft_digest: str
    actor: str = DEFAULT_ACTOR


class DecideIn(BaseModel):
    actor: str = DEFAULT_ACTOR


class ForgetIn(BaseModel):
    """`fields=None` erases every x-pii field the entity's types declare."""

    fields: list[str] | None = None
    actor: str = DEFAULT_ACTOR
