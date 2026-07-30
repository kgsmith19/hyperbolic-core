"""The focus-3 rule (ADR-019 rule 3): at most three intentions carry focus=true.

Three focus goals are the cockpit's whole point — a fourth is a priority list
again — so the service refuses the fourth instead of displaying it, and the
refusal offers rotation, never addition. The rule lives here in the domain:
the generic capture door dispatches to `guard_capture` (the bills/documents
dispatch precedent) and in-process writers capture through
`capture_intention`, so both doors meet the same rule.
"""

from typing import Any

from domains.intentions.types import TYPE_NAME
from kernel import services
from kernel.access import AccessContext
from kernel.events import DEFAULT_ACTOR

FOCUS_LIMIT = 3


class FocusLimitExceeded(ValueError):
    """A capture that would create a fourth focus=true intention (422 at the door)."""


def guard_capture(ctx: AccessContext, type_name: str, attributes: dict[str, Any]) -> None:
    """Refuse a capture that would push past FOCUS_LIMIT focus intentions.

    Counting is by identity (`title`): re-capturing an already-focused
    intention merges into it (supersede, invariant 3), so it is never the
    fourth. The count reads current intentions with the caller's own context
    (invariant 5) — capturing a focus intention takes `intentions:read` as
    well as `intentions:write`.

    Runs before schema validation, so it keys on `focus is True`: a payload
    carrying a truthy non-boolean `focus` is not counted here and fails the
    schema inside `capture` instead.

    Keyed on the type name — the opposite choice from the bills/documents
    locks, stated honestly. Those cells embargo their identity keys door-wide,
    which works because `bill_key` and `sha256` are theirs alone; `title`
    cannot be embargoed, because other types carry one legitimately
    (`calendar_event` already does). So a fresh type declaring
    `x-identity: ["title"]` could merge `focus: true` onto an existing
    intention past this guard. Accepted: focus is display state with no
    authority attached — nothing grants, sends, or scores on it (INT1 is
    display-only) — and one re-capture repairs it.
    """
    if type_name != TYPE_NAME or attributes.get("focus") is not True:
        return
    focused = services.find(ctx, type_name=TYPE_NAME, filters={"focus": True})
    others = [e for e in focused if e.attributes.get("title") != attributes.get("title")]
    if len(others) >= FOCUS_LIMIT:
        raise FocusLimitExceeded(
            f"at most {FOCUS_LIMIT} intentions may be focus=true; "
            "clear one focus goal before focusing another"
        )


def capture_intention(
    ctx: AccessContext, attributes: dict[str, Any], actor: str = DEFAULT_ACTOR
) -> services.CaptureResult:
    """Capture one intention through the focus rule — the in-process door."""
    guard_capture(ctx, TYPE_NAME, attributes)
    return services.capture(ctx, TYPE_NAME, attributes, actor=actor)
