"""Episode types as registry data (invariant 1, roadmap EP1). Zero kernel DDL.

Two types, both operator-authored through generic capture and **both
``x-sensitive: true`` in this, their first definition** — the flag is never
added by a later migration, so there is no window in which the domain is
readable through the shared agent-tool surface (ADR 016). They live in a
domain of their own because withholding is domain-shaped (scopes are,
invariant 5): flagging one type withholds every type beside it.

- ``episode`` is one episode as the operator records it: when it started, what
  perturbations were around, how intense it is today, whether it impaired
  function, how long the operator feared it would last — and, once it ends,
  when it actually ended and a retrospective note. ``onset_date`` is the
  identity key, so the daily in-episode intensity capture is a plain entity
  update that merges into the same record: the append-only event history IS
  the intensity time series, and no episode-specific capture path exists.
- ``playbook`` is the operator's own versioned if-then plan. It declares **no
  identity fields, deliberately**: a capture with no identity can never
  resolve onto an existing entity and nothing can merge into one (the
  authority_receipt precedent, ADR 014/018) — so a recorded version is
  immutable through the capture door by construction, and "append-only
  versions" is structure, not policy. The guard in ``capture.guard_capture``
  closes the remaining gap: re-capturing an already-recorded (name, version)
  pair would mint a second record claiming to be that version, so it is
  refused — a new version is appended under the next number instead.

Identity is never PII (ADR 012): ``onset_date`` and the playbook's ``name``
and ``version`` survive ``forget()`` as the honest husk — "an episode starting
on this date existed", "version N of this playbook existed" — while every
other episode field and the playbook's ``steps`` are x-pii and erasable.
Only the non-PII spine is required, so an erased record stays valid against
its own schema (the bills precedent).

No prediction, no risk scores, no physiology dashboards, no push prompts, no
exposure coaching, no clinical advice; pull-only — no notification path may
exist in code (roadmap §EP1 pre-made decisions; the cell constitution records
them verbatim).
"""

from typing import Any

from kernel.access import AccessContext
from kernel.services import define_missing

DOMAIN = "episodes"
TYPE_EPISODE = "episode"
TYPE_PLAYBOOK = "playbook"

INTENSITY_MIN = 0
INTENSITY_MAX = 10

MAX_TAG = 64
MAX_TAGS = 20
MAX_NOTE = 2000
MAX_NAME = 200
MAX_STEP = 500
MAX_STEPS = 50

# Operator-typed ISO dates. `date.fromisoformat` in the capture guard and the
# duration arithmetic downstream (T2) both need exactly this shape.
_DATE = {"type": "string", "pattern": r"^\d{4}-\d{2}-\d{2}$"}

EPISODE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "onset_date": _DATE,
        "perturbation_tags": {
            "type": "array",
            "items": {"type": "string", "minLength": 1, "maxLength": MAX_TAG},
            "maxItems": MAX_TAGS,
        },
        "intensity": {"type": "integer", "minimum": INTENSITY_MIN, "maximum": INTENSITY_MAX},
        "function_impact": {"type": "boolean"},
        "feared_duration_days": {"type": "integer", "minimum": 1},
        "end_date": _DATE,
        "retro_note": {"type": "string", "maxLength": MAX_NOTE},
    },
    # Required in every capture payload, not just the first: it is how a daily
    # intensity update resolves onto its episode, and the guard compares
    # `end_date` against it without a read.
    "required": ["onset_date"],
    "additionalProperties": False,
    "x-identity": ["onset_date"],
    "x-pii": [
        "perturbation_tags",
        "intensity",
        "function_impact",
        "feared_duration_days",
        "end_date",
        "retro_note",
    ],
    # Withheld from the shared agent-tool surface from the first definition
    # (ADR 016); never added by a later migration.
    "x-sensitive": True,
}

# One if-then step of the operator's own plan. Free text the operator writes
# about their own life: x-pii on the record (via `steps`), and never
# model-readable (the domain is withheld).
_STEP = {
    "type": "object",
    "properties": {
        "if": {"type": "string", "minLength": 1, "maxLength": MAX_STEP},
        "then": {"type": "string", "minLength": 1, "maxLength": MAX_STEP},
    },
    "required": ["if", "then"],
    "additionalProperties": False,
}

PLAYBOOK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": MAX_NAME},
        "version": {"type": "integer", "minimum": 1},
        "steps": {"type": "array", "items": _STEP, "minItems": 1, "maxItems": MAX_STEPS},
    },
    "required": ["name", "version"],
    "additionalProperties": False,
    # No x-identity, deliberately: see the module docstring.
    "x-pii": ["steps"],
    "x-sensitive": True,
}

_TYPES = {TYPE_EPISODE: EPISODE_SCHEMA, TYPE_PLAYBOOK: PLAYBOOK_SCHEMA}


def define_episode_types(ctx: AccessContext) -> list[str]:
    """Define any missing episode types. Idempotent; returns what it defined."""
    return define_missing(ctx, DOMAIN, _TYPES)
