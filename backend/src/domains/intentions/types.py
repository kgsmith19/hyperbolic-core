"""Intention types as registry data (invariant 1, roadmap INT1). Zero kernel DDL.

One type: `intention`, the operator's declared priority — what is being moved
on (`kind`), whether it is one of the at-most-three focus goals (`focus`,
enforced in `domains.intentions.focus`), and the floor: the smallest version
that still counts on a bad day. Floors are plain strings, by decision.
"""

from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

DOMAIN = "intentions"
TYPE_NAME = "intention"

KINDS = ("task", "project", "habit_quota", "research_errand", "recurring_commitment")

# What the priority-list import writes and what a human has not yet touched:
# a candidate is an LLM-proposed row awaiting the operator's confirming
# re-capture through the capture UI (status is theirs to overwrite).
STATUS_CANDIDATE = "candidate"

MAX_TITLE = 200
MAX_ACTION = 500

# `title` is the identity key so a re-capture supersedes instead of duplicating
# (invariant 3, and what makes the priority-list import idempotent) — and is
# therefore deliberately NOT x-pii: forget() strips x-pii fields, and keying on
# one would make an erased intention unfindable (the calendar cell's
# identity-is-never-PII rule, ADR 012). The remaining free text the operator
# writes about their own life is x-pii and erasable.
INTENTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "minLength": 1, "maxLength": MAX_TITLE},
        "kind": {"type": "string", "enum": list(KINDS)},
        "status": {"type": "string", "maxLength": 64},
        "focus": {"type": "boolean"},
        "floor": {"type": ["string", "null"], "maxLength": 500},
        "next_action": {"type": "string", "maxLength": MAX_ACTION},
        "source": {"type": "string", "maxLength": 200},
    },
    "required": ["title", "kind", "status", "focus"],
    "additionalProperties": False,
    "x-identity": ["title"],
    "x-pii": ["floor", "next_action", "source"],
}

_TYPES = {TYPE_NAME: INTENTION_SCHEMA}


def define_intention_types(ctx: AccessContext) -> list[str]:
    """Define any missing intention types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
