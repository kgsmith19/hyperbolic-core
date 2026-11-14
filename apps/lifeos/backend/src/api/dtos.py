"""Request DTOs. Responses reuse kernel models directly — the API adds nothing."""

from datetime import date, datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict

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


class SnoozeIn(BaseModel):
    """#532 Needs Me: hide an item until this date (must be after today)."""

    until: date
    actor: str = DEFAULT_ACTOR


class RescheduleIn(BaseModel):
    """#532 Needs Me: set the deadline and name where it came from."""

    deadline: date
    source: str
    actor: str = DEFAULT_ACTOR


class CompleteIn(BaseModel):
    """#532 Needs Me: completion needs evidence (your confirmation or a named source)."""

    evidence: str
    actor: str = DEFAULT_ACTOR


class ProgressIn(BaseModel):
    """#531: one intention progress change (validated by domains.intentions.today)."""

    progress: str
    actor: str = DEFAULT_ACTOR
    evidence: str | None = None


class DoneIn(BaseModel):
    """#Q5: mark an intention done. Moving into DONE needs completion evidence."""

    actor: str = DEFAULT_ACTOR
    evidence: str | None = None


class ProposeActionIn(BaseModel):
    """M4-20's `proposeAction` (05-e-lifeos.md section 3): kind names a
    task class, summary is the exact text an operator reviews and
    approves against (the digest binds to this, never to payload), and
    payload is opaque -- this system stores and displays it, and never
    parses or acts on it."""

    kind: str
    summary: str
    payload: dict[str, Any] = {}


class ForgetIn(BaseModel):
    """`fields=None` erases every x-pii field the entity's types declare."""

    fields: list[str] | None = None
    actor: str = DEFAULT_ACTOR


class AgentRequestIn(BaseModel):
    """#596: ask the role gate once. There is deliberately no `approved` and no
    `requested_by`: any extra field, those two included, is refused (422)."""

    model_config = ConfigDict(extra="forbid")

    role: str
    permission: str
    idempotency_key: str


class RegistryNeedsMeItem(BaseModel):
    """One open Operations Registry record that needs the operator (#630). Copied from the sheet
    as captured; nothing is invented, and `flags` says what is missing or unverified."""

    entity_id: UUID
    source_kind: str
    source_key: str
    external_id: str
    title: str
    status_text: str | None
    next_action: str | None
    deadline: str | None
    deadline_source: str | None
    source_url: str | None
    flags: list[str]


class ConsentReceiptOut(BaseModel):
    requested_by: str
    requested_at: str
    receipt_key: str
