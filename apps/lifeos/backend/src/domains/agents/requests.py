"""Agent controller requests to the role gate (#596, under #573).

A controller (a ChatGPT or Claude client holding a per-controller token) asks the
gate for a decision. It never executes anything and never approves anything.

Rules this module holds to (owner decision on #596):

- Asking needs the `agents:request` scope, which grants nothing else. Recording is
  done here under a context built in code, so the token itself never holds
  `agents:write`.
- `requested_by` is the verified token subject, passed in by the route. It is
  never read from the request body.
- A token bound to a role allowlist cannot ask as any other role.
- Controllers may ask only for observation and draft permissions (the owner's
  "draft and observe only"). Anything stronger is refused before the gate.
- `approved` is always False here. Consequential communication stays denied
  until an owner-session approval exists.
- The idempotency key is namespaced by the requester, so two controllers using
  the same key never share a receipt, and a retry by the same controller returns
  its original receipt as a duplicate.
- An allowed receipt executes nothing.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from domains.agents.receipts import DOMAIN, SCOPE_READ, SCOPE_WRITE, Receipt, record
from domains.agents.roles import PERMISSION_CLASS, ActionClass, Role, RoleRegistry
from kernel import services
from kernel.access import AccessContext, require
from kernel.services import define_missing

SCOPE_REQUEST = "agents:request"
TYPE_REQUEST = "agent_request"
REQUESTABLE_CLASSES = frozenset({ActionClass.OBSERVATION, ActionClass.DRAFT})

REQUEST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "receipt_key": {"type": "string", "minLength": 64, "maxLength": 64},
        "requested_by": {"type": "string", "minLength": 1, "maxLength": 128},
        "requested_at": {"type": "string", "maxLength": 40},
    },
    "required": ["receipt_key", "requested_by", "requested_at"],
    "additionalProperties": False,
    "x-identity": ["receipt_key"],
}

# The narrow context recording runs under. Built here, never granted to a token.
_RECORDER = AccessContext.of(SCOPE_WRITE, SCOPE_READ)


class RequestRefused(PermissionError):
    """The controller may not ask this question at all; nothing is recorded."""


@dataclass(frozen=True, slots=True)
class RequestResult:
    receipt: Receipt
    requested_by: str


def guard_capture(type_name: str) -> None:
    """Refuse the generic capture route: only `request` writes these."""
    if type_name == TYPE_REQUEST:
        raise ValueError(f"{TYPE_REQUEST} records are written only by the request route")


def parse_role(value: str) -> Role:
    try:
        return Role(value)
    except ValueError:
        raise RequestRefused(f"unknown role {value!r}") from None


def request(
    ctx: AccessContext,
    registry: RoleRegistry,
    role: Role,
    permission: str,
    idempotency_key: str,
    *,
    requested_by: str,
    allowed_roles: Iterable[str] | None,
) -> RequestResult:
    """Ask the gate once, as `requested_by`. `allowed_roles` None means unrestricted
    (an owner session); an agent token always carries its allowlist."""
    require(ctx, SCOPE_REQUEST)
    if not requested_by.strip():
        raise RequestRefused("a verified requester is required")
    if allowed_roles is not None and role.value not in set(allowed_roles):
        raise RequestRefused(f"this controller may not request as {role.value}")
    action = PERMISSION_CLASS.get(permission)
    if action is not None and action not in REQUESTABLE_CLASSES:
        raise RequestRefused(
            f"controllers may request only observation or draft, not {action.value}"
        )
    if not idempotency_key.strip():
        raise ValueError("an idempotency key is required")
    namespaced = f"{requested_by}\x1f{idempotency_key}"
    receipt = record(_RECORDER, registry, role, permission, namespaced, approved=False)
    if not receipt.duplicate:
        define_missing(_RECORDER, DOMAIN, {TYPE_REQUEST: REQUEST_SCHEMA})
        services.capture(
            _RECORDER,
            TYPE_REQUEST,
            {
                "receipt_key": receipt.receipt_key,
                "requested_by": requested_by,
                "requested_at": datetime.now(UTC).isoformat(),
            },
            actor=requested_by,
        )
    return RequestResult(receipt=receipt, requested_by=requested_by)


def requester_of(ctx: AccessContext, receipt_key: str) -> str | None:
    """Who asked for a receipt, or None when it was not made through this route."""
    require(ctx, SCOPE_READ)
    found = services.find(ctx, type_name=TYPE_REQUEST, filters={"receipt_key": receipt_key})
    return str(found[0].attributes["requested_by"]) if found else None
