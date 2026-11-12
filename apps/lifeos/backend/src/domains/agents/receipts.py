"""Durable, idempotent agent action receipts (#592, under #573).

Every role-gate decision (allowed or denied) is recorded as one `agent_action_receipt`.
A receipt is identified by a hash of (role, permission, idempotency key), so the
same request always resolves to the same record.

Rules held here:

- A retry with the same key returns the original receipt as a duplicate and writes
  nothing. A retry is never re-decided, so it cannot turn a denial into an approval,
  even if the registry has changed since.
- Allowed and denied requests are both recorded, with the gate's reason and the
  permission's action class.
- The record holds a hash, not the idempotency key itself, and no payload or
  free text, so it cannot leak what an agent was asked to do.
- Recording needs `agents:write`; reading needs `agents:read`. A blank idempotency
  key is refused.
- The generic capture route refuses this type: receipts are written only through
  `record`.
- Nothing here executes the action. No route, token, controller identity or endpoint.
"""

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from domains.agents.roles import PERMISSION_CLASS, Role, RoleRegistry, decide
from kernel import services
from kernel.access import AccessContext, require
from kernel.events import DEFAULT_ACTOR
from kernel.services import define_missing

DOMAIN = "agents"
TYPE_RECEIPT = "agent_action_receipt"
SCOPE_WRITE = "agents:write"
SCOPE_READ = "agents:read"
UNKNOWN_CLASS = "unknown"

RECEIPT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "receipt_key": {"type": "string", "minLength": 64, "maxLength": 64},
        "role": {"type": "string", "maxLength": 64},
        "permission": {"type": "string", "maxLength": 128},
        "action_class": {"type": "string", "maxLength": 64},
        "allowed": {"type": "boolean"},
        "reason": {"type": "string", "maxLength": 200},
        "recorded_at": {"type": "string", "maxLength": 40},
    },
    "required": [
        "receipt_key",
        "role",
        "permission",
        "action_class",
        "allowed",
        "reason",
        "recorded_at",
    ],
    "additionalProperties": False,
    "x-identity": ["receipt_key"],
}


@dataclass(frozen=True, slots=True)
class Receipt:
    receipt_key: str
    role: str
    permission: str
    action_class: str
    allowed: bool
    reason: str
    recorded_at: str
    duplicate: bool
    entity_id: UUID | None


def receipt_key(role: str, permission: str, idempotency_key: str) -> str:
    """The identity of one request: a SHA-256 of role, permission and idempotency key."""
    material = "\x1f".join((role, permission, idempotency_key))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def define_receipt_types(ctx: AccessContext) -> list[str]:
    """Define the receipt type if missing. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, {TYPE_RECEIPT: RECEIPT_SCHEMA})


def guard_capture(type_name: str) -> None:
    """Refuse the generic capture route for receipts: only `record` writes them."""
    if type_name == TYPE_RECEIPT:
        raise ValueError(f"{TYPE_RECEIPT} records are written only by the gate, not by capture")


def _find(ctx: AccessContext, key: str) -> Any | None:
    found = services.find(ctx, type_name=TYPE_RECEIPT, filters={"receipt_key": key})
    return found[0] if found else None


def _receipt(attributes: dict[str, Any], entity_id: UUID | None, duplicate: bool) -> Receipt:
    return Receipt(
        receipt_key=str(attributes["receipt_key"]),
        role=str(attributes["role"]),
        permission=str(attributes["permission"]),
        action_class=str(attributes["action_class"]),
        allowed=bool(attributes["allowed"]),
        reason=str(attributes["reason"]),
        recorded_at=str(attributes["recorded_at"]),
        duplicate=duplicate,
        entity_id=entity_id,
    )


def get_by_key(
    ctx: AccessContext, role: Role, permission: str, idempotency_key: str
) -> Receipt | None:
    """Read a receipt back from the kernel by its request identity, or None."""
    require(ctx, SCOPE_READ)
    if not idempotency_key.strip():
        raise ValueError("an idempotency key is required")
    entity = _find(ctx, receipt_key(role.value, permission, idempotency_key))
    if entity is None:
        return None
    return _receipt(entity.attributes, entity.id, duplicate=False)


def record(
    ctx: AccessContext,
    registry: RoleRegistry,
    role: Role,
    permission: str,
    idempotency_key: str,
    *,
    approved: bool = False,
    actor: str = DEFAULT_ACTOR,
) -> Receipt:
    """Decide one request through the gate and persist its receipt, once per key.

    A repeat returns the original receipt as a duplicate and writes nothing.
    """
    require(ctx, SCOPE_WRITE)
    if not idempotency_key.strip():
        raise ValueError("an idempotency key is required")
    define_receipt_types(ctx)

    key = receipt_key(role.value, permission, idempotency_key)
    existing = _find(ctx, key)
    if existing is not None:
        return _receipt(existing.attributes, existing.id, duplicate=True)

    decision = decide(registry, role, permission, approved=approved)
    action = PERMISSION_CLASS.get(permission)
    attributes: dict[str, Any] = {
        "receipt_key": key,
        "role": role.value,
        "permission": permission,
        "action_class": action.value if action is not None else UNKNOWN_CLASS,
        "allowed": decision.allowed,
        "reason": decision.reason[:200],
        "recorded_at": datetime.now(UTC).isoformat(),
    }
    result = services.capture(ctx, TYPE_RECEIPT, attributes, actor=actor)
    return _receipt(attributes, result.entity_id, duplicate=False)
