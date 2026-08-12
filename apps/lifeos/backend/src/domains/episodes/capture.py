"""The episodes capture-door rules (roadmap EP1).

Both types are operator-authored through generic capture, so the generic door
gets this cell's lock (the bills/documents/intentions dispatch precedent):

- ``intensity`` stays within 0-10 and ``feared_duration_days`` stays positive.
  The schema bounds both as well; the guard is the door's half of the same
  rule and gives the refusal a name instead of a schema traceback.
- ``end_date`` is never before ``onset_date``. A cross-field rule the schema
  cannot express. Compared on the payload alone: ``onset_date`` is required in
  every episode capture (it is the identity key the update resolves on), so
  the payload always carries both sides of the comparison.
- Playbook versions are append-only — a new version never edits a prior one.
  ``playbook`` declares no identity fields, so a capture can never resolve
  onto a recorded version and nothing can merge into one (the
  authority_receipt precedent); what remains is a capture re-claiming an
  already-recorded (name, version) pair, which would mint a second record
  claiming to be that version, and is refused here.
- ``onset_date`` is embargoed door-wide (the PR #49 guard-the-record
  precedent): resolution reaches a record only through an identity field the
  record's own type declares, so a foreign type declaring
  ``x-identity: ["onset_date"]`` could otherwise merge past a name-keyed
  guard into an episode. A payload carrying this cell's identity key must be
  a capture of the type that owns it.

Stated honestly (the bills guard's caveat): this covers the external door.
In-process code holding ``episodes:write`` can call ``services.capture``
directly — that is inside the trust boundary (ADR 003).
"""

from datetime import date
from typing import Any

from domains.episodes.types import (
    INTENSITY_MAX,
    INTENSITY_MIN,
    TYPE_EPISODE,
    TYPE_PLAYBOOK,
)
from kernel import services
from kernel.access import AccessContext


class EpisodeCaptureRefused(ValueError):
    """A capture that breaks an episodes-cell rule (422 at the door)."""


# The identity key episode records merge on, embargoed door-wide: no other
# type may carry it (see the module docstring).
OWNED_KEYS = {"onset_date": TYPE_EPISODE}


def _number(value: Any) -> int | float | None:
    """A numeric attribute value, or None when absent or mistyped — a mistyped
    value is the schema's refusal to make, inside ``capture``."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return value


def _parsed_date(value: Any) -> date | None:
    """An ISO date value, or None when absent or unparsable (the schema's
    pattern refuses the latter inside ``capture``)."""
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def guard_capture(ctx: AccessContext, type_name: str, attributes: dict[str, Any]) -> None:
    """Refuse a ``POST /capture`` that breaks an episodes rule.

    The playbook check reads current records with the caller's own context
    (invariant 5): capturing a playbook takes ``episodes:read`` as well as
    ``episodes:write``. No value from the payload is echoed in a refusal —
    these are episode records, and an error message is the one string that
    routinely ends up in logs.
    """
    for key_field, owner in OWNED_KEYS.items():
        if key_field in attributes and type_name != owner:
            raise EpisodeCaptureRefused(
                f"'{key_field}' is the identity field of '{owner}'; a capture of "
                f"'{type_name}' carrying it would merge into that record"
            )
    if type_name == TYPE_EPISODE:
        _guard_episode(attributes)
    elif type_name == TYPE_PLAYBOOK:
        _guard_playbook(ctx, attributes)


def _guard_episode(attributes: dict[str, Any]) -> None:
    intensity = _number(attributes.get("intensity"))
    if intensity is not None and not (INTENSITY_MIN <= intensity <= INTENSITY_MAX):
        raise EpisodeCaptureRefused(f"intensity must be within {INTENSITY_MIN}-{INTENSITY_MAX}")
    feared = _number(attributes.get("feared_duration_days"))
    if feared is not None and feared <= 0:
        raise EpisodeCaptureRefused("feared_duration_days must be positive")
    end = _parsed_date(attributes.get("end_date"))
    onset = _parsed_date(attributes.get("onset_date"))
    if end is not None and onset is not None and end < onset:
        raise EpisodeCaptureRefused("end_date must not be before onset_date")


def _guard_playbook(ctx: AccessContext, attributes: dict[str, Any]) -> None:
    name = attributes.get("name")
    version = attributes.get("version")
    if not isinstance(name, str) or isinstance(version, bool) or not isinstance(version, int):
        return  # malformed payload: the schema refuses it inside capture
    existing = services.find(
        ctx, type_name=TYPE_PLAYBOOK, filters={"name": name, "version": version}
    )
    if existing:
        raise EpisodeCaptureRefused(
            "playbook versions are append-only: this name and version are already "
            "recorded — capture the next version number instead of editing"
        )
