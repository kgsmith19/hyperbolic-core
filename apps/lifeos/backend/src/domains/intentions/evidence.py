"""Completion evidence for intentions: DONE is never inferred from silence (Q5).

A transition into DONE needs the operator's own confirmation or a named external
source, recorded as `completion_evidence`. This module is the one rule that every
DONE write path shares: the progress route, the done route, and the generic
capture door.

Grandfathering: a row that is already DONE is not refused when it is edited again,
so existing history is never made to fail. Only a new transition into DONE is held
to the rule. Nothing here rewrites past events.
"""

from typing import Any

from domains.intentions.types import TYPE_NAME
from kernel import services
from kernel.access import AccessContext

MAX_EVIDENCE = 500
MISSING_EVIDENCE = "completion needs evidence: your own confirmation or a named external source"


def is_done(attributes: dict[str, Any]) -> bool:
    return attributes.get("done") is True or attributes.get("progress") == "DONE"


def clean_evidence(evidence: str | None) -> str | None:
    if evidence is None:
        return None
    text = evidence.strip()
    if len(text) > MAX_EVIDENCE:
        raise ValueError(f"completion evidence is limited to {MAX_EVIDENCE} characters")
    return text or None


def require_evidence(old: dict[str, Any] | None, new: dict[str, Any]) -> None:
    """Refuse a new transition into DONE that carries no completion evidence."""
    if not is_done(new):
        return
    if old is not None and is_done(old):
        return  # already DONE: grandfathered, not made to fail
    if not clean_evidence(new.get("completion_evidence")):
        raise ValueError(MISSING_EVIDENCE)


def guard_done_capture(ctx: AccessContext, type_name: str, attributes: dict[str, Any]) -> None:
    """The generic capture door: a capture that sets DONE must carry evidence."""
    if type_name != TYPE_NAME or not is_done(attributes):
        return
    title = attributes.get("title")
    existing = services.find(ctx, type_name=TYPE_NAME, filters={"title": title}) if title else []
    old = existing[0].attributes if existing else None
    require_evidence(old, attributes)
