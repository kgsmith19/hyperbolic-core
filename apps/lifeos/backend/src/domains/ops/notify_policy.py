"""Notification delivery policy with acknowledgement-only delivery (#593, part of #575).

Pure: no transport, push, device bridge, network, scheduling or persistence. It
decides whether one notice is sent now, held or dropped, and moves a delivery
through a small state machine in which only a device acknowledgement makes a
notice delivered.

Rules this module holds to (from #593):

- A category the owner has not opted in to is dropped. Revocation drops
  everything, urgent included.
- Quiet hours (which may wrap midnight) and protected family anchors hold
  non-urgent notices. Urgent notices pass.
- A sent notice is held while awaiting acknowledgement, retried after the
  timeout, and dropped once the attempt budget is spent.
- An acknowledged, failed or dropped notice is never sent again.
- Only an acknowledgement counts as delivered. A server send is never delivery.
  Invalid state transitions are refused.
- A notice carries a dedupe key and a category, never message text.
"""

import re
from dataclasses import dataclass, replace
from datetime import datetime, time, timedelta
from typing import Literal

Status = Literal["pending", "sent", "acknowledged", "failed", "dropped"]
Action = Literal["send", "hold", "drop"]
Event = Literal["sent", "acknowledged", "failed", "dropped"]

FINAL: frozenset[str] = frozenset({"acknowledged", "failed", "dropped"})
_KEY = re.compile(r"^[a-z0-9][a-z0-9:._-]{0,127}$")
_TRANSITIONS: dict[str, frozenset[str]] = {
    "sent": frozenset({"pending", "sent"}),
    "acknowledged": frozenset({"sent"}),
    "failed": frozenset({"sent"}),
    "dropped": frozenset({"pending", "sent"}),
}


@dataclass(frozen=True, slots=True)
class Notice:
    """What may be delivered: a dedupe key and a category. Never message text."""

    dedupe_key: str
    category: str
    urgent: bool = False

    def __post_init__(self) -> None:
        if not _KEY.fullmatch(self.dedupe_key) or not _KEY.fullmatch(self.category):
            raise ValueError("dedupe key and category are short identifiers, never message text")


@dataclass(frozen=True, slots=True)
class Policy:
    opted_in: frozenset[str]
    revoked: bool = False
    quiet_start: time | None = None
    quiet_end: time | None = None
    anchors: tuple[tuple[time, time], ...] = ()
    ack_timeout: timedelta = timedelta(minutes=10)
    max_attempts: int = 3


@dataclass(frozen=True, slots=True)
class Delivery:
    status: Status = "pending"
    attempts: int = 0
    last_sent_at: datetime | None = None

    @property
    def delivered(self) -> bool:
        return self.status == "acknowledged"


@dataclass(frozen=True, slots=True)
class Decision:
    action: Action
    reason: str


def _within(now: time, start: time, end: time) -> bool:
    """True when ``now`` is inside [start, end), wrapping midnight when start > end."""
    if start <= end:
        return start <= now < end
    return now >= start or now < end


def decide(notice: Notice, delivery: Delivery, policy: Policy, now: datetime) -> Decision:
    if delivery.status in FINAL:
        return Decision("drop", f"already {delivery.status}; never sent again")
    if policy.revoked:
        return Decision("drop", "notifications revoked")
    if notice.category not in policy.opted_in:
        return Decision("drop", f"category {notice.category!r} not opted in")
    if delivery.status == "sent":
        if delivery.last_sent_at is None:
            raise ValueError("a sent notice must record when it was sent")
        if now - delivery.last_sent_at < policy.ack_timeout:
            return Decision("hold", "awaiting acknowledgement")
        if delivery.attempts >= policy.max_attempts:
            return Decision("drop", "attempt budget spent without acknowledgement")
    if not notice.urgent:
        clock = now.time()
        if (
            policy.quiet_start is not None
            and policy.quiet_end is not None
            and _within(clock, policy.quiet_start, policy.quiet_end)
        ):
            return Decision("hold", "quiet hours")
        if any(_within(clock, start, end) for start, end in policy.anchors):
            return Decision("hold", "protected family anchor")
    return Decision("send", "retry after timeout" if delivery.status == "sent" else "deliver")


def transition(delivery: Delivery, event: Event, now: datetime) -> Delivery:
    """Apply one delivery event. Refuses any transition the state machine does not allow."""
    allowed = _TRANSITIONS.get(event)
    if allowed is None or delivery.status not in allowed:
        raise ValueError(f"cannot apply {event!r} to a {delivery.status} notice")
    if event == "sent":
        return replace(delivery, status="sent", attempts=delivery.attempts + 1, last_sent_at=now)
    return replace(delivery, status=event)
