"""trigger_feedback: was a scheduled output worth producing? (ADR 014)

Written by a human, never by a job — no pass may grade its own output. It
exists so "this briefing was noise" becomes a recorded signal for the
prospective-copilot milestone instead of a lost opinion.

Keyed on ``subject_id``, so re-judging supersedes via ``entity.updated`` and the
earlier verdict stays in history (invariant 3). ``note`` is free text the owner
writes and may name a person, so it is ``x-pii`` and erasable via ``forget()``.
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from domains.ops.types import MAX_NOTE, VERDICTS, define_ops_types
from kernel import services
from kernel.access import AccessContext

METHOD = "domains.ops.feedback"


def record_feedback(
    ctx: AccessContext,
    subject_id: UUID,
    verdict: str,
    note: str | None = None,
    actor: str = METHOD,
) -> UUID:
    """Record a human verdict on a produced entity (usually a briefing).

    The subject must exist and be readable by the caller, so feedback on a
    non-``ops`` subject needs that domain's read scope too.
    """
    define_ops_types(ctx)
    services.get_entity(ctx, subject_id)
    attributes: dict[str, Any] = {
        "subject_id": str(subject_id),
        "verdict": verdict,
        "recorded_at": datetime.now(UTC).isoformat(),
    }
    if note:
        attributes["note"] = note[:MAX_NOTE]
    return services.capture(ctx, "trigger_feedback", attributes, actor=actor).entity_id


def feedback_context() -> AccessContext:
    """Exactly the scopes recording a verdict on an ops entity needs."""
    return AccessContext.of("ops:read", "ops:write")


__all__ = ["VERDICTS", "feedback_context", "record_feedback"]
