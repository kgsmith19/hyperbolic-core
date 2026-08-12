"""ICS parsing. Feed content is UNTRUSTED network input (ADR 012).

Bounds: the caller caps feed bytes before parsing; VEVENTs missing UID or
DTSTART are dropped with a count instead of crashing; text fields are
truncated to the schema bounds; recurrence expansion is windowed and capped
so a hostile RRULE (e.g. FREQ=SECONDLY) cannot explode the run. Parsed text
only ever reaches the database through kernel services, which parameterize.

Identity (idempotency + supersede semantics):
- every expanded occurrence carries RECURRENCE-ID = its original slot, so
  ``ics_key`` is ``uid`` for one-off events (a rescheduled event updates the
  same appointment) and ``uid:slot`` for recurring series (each occurrence is
  its own appointment; a moved instance keeps its slot key);
- ``vevent_hash`` is the sha256 of the occurrence's canonical serialization —
  unchanged VEVENTs re-hash identically, so re-runs emit nothing new.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime
from hashlib import sha256
from typing import Any

import icalendar
import recurring_ical_events

from domains.calendar.types import MAX_TEXT

MAX_OCCURRENCES = 1000  # expansion cap per feed
MAX_ATTENDEES = 50  # per event


@dataclass(frozen=True)
class Attendee:
    email: str
    name: str | None


@dataclass(frozen=True)
class Occurrence:
    ics_key: str
    vevent_hash: str
    attributes: dict[str, Any]  # ready-to-capture appointment attributes
    attendees: tuple[Attendee, ...]


@dataclass(frozen=True)
class ParsedFeed:
    occurrences: tuple[Occurrence, ...]
    skipped: int  # malformed components dropped, not crashed on
    truncated: bool  # hit MAX_OCCURRENCES


def _utc_iso(value: date | datetime) -> tuple[str, bool]:
    """Normalize to a UTC ISO string; date-only values are all-day."""
    if isinstance(value, datetime):
        if value.tzinfo is None:  # floating time: pin to UTC rather than guess
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).isoformat(), False
    return f"{value.isoformat()}T00:00:00+00:00", True


def _as_datetime(value: date | datetime) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    return datetime(value.year, value.month, value.day, tzinfo=UTC)


def _text(component: icalendar.Event, prop: str, bound: int = MAX_TEXT) -> str | None:
    value = component.get(prop)
    return None if value is None else str(value)[:bound]


def _attendees(component: icalendar.Event) -> tuple[Attendee, ...]:
    raw = component.get("ATTENDEE")
    if raw is None:
        return ()
    values = raw if isinstance(raw, list) else [raw]
    out: list[Attendee] = []
    for value in values[:MAX_ATTENDEES]:
        email = str(value).removeprefix("mailto:").strip().lower()[:255]
        if "@" not in email:
            continue
        name = value.params.get("CN") if hasattr(value, "params") else None
        out.append(Attendee(email=email, name=str(name)[:255] if name else None))
    return tuple(out)


def _occurrence(component: icalendar.Event, recurring_uids: set[str]) -> Occurrence:
    uid = str(component.get("UID"))[:255]
    starts_at, all_day = _utc_iso(component.decoded("DTSTART"))
    slot = (
        component.decoded("RECURRENCE-ID")
        if component.get("RECURRENCE-ID") is not None
        else component.decoded("DTSTART")
    )
    ics_key = f"{uid}:{_utc_iso(slot)[0]}" if uid in recurring_uids else uid
    attributes: dict[str, Any] = {
        "ics_key": ics_key,
        "uid": uid,
        "title": _text(component, "SUMMARY") or "(untitled)",
        "starts_at": starts_at,
        "sequence": int(component.get("SEQUENCE") or 0),
        "all_day": all_day,
        "vevent_hash": sha256(component.to_ical()).hexdigest(),
    }
    if component.get("DTEND") is not None:
        attributes["ends_at"] = _utc_iso(component.decoded("DTEND"))[0]
    if (location := _text(component, "LOCATION")) is not None:
        attributes["location"] = location
    if (status := _text(component, "STATUS", 32)) is not None:
        attributes["status"] = status
    return Occurrence(
        ics_key=ics_key,
        vevent_hash=attributes["vevent_hash"],
        attributes=attributes,
        attendees=_attendees(component),
    )


def parse_ics(content: bytes, window_start: datetime, window_end: datetime) -> ParsedFeed:
    """Parse a feed and expand recurrences inside [window_start, window_end]."""
    try:
        calendar = icalendar.Calendar.from_ical(content)
    except Exception as exc:
        raise ValueError(f"not a parseable ICS feed: {type(exc).__name__}") from exc

    # Drop malformed VEVENTs (missing UID/DTSTART) with a count — the expander
    # crashes on them — and learn which UIDs are recurring series, because the
    # expander strips RRULE from the occurrence copies it returns.
    skipped = 0
    recurring_uids: set[str] = set()
    kept = []
    for component in calendar.subcomponents:
        if component.name == "VEVENT":
            if component.get("UID") is None or component.get("DTSTART") is None:
                skipped += 1
                continue
            if any(component.get(prop) is not None for prop in ("RRULE", "RDATE", "RECURRENCE-ID")):
                recurring_uids.add(str(component.get("UID"))[:255])
        kept.append(component)
    calendar.subcomponents = kept

    occurrences: list[Occurrence] = []
    truncated = False
    query = recurring_ical_events.of(calendar, skip_bad_series=True)
    for component in query.after(window_start):  # generator, in start order
        try:
            if _as_datetime(component.decoded("DTSTART")) > window_end:
                break
            if len(occurrences) >= MAX_OCCURRENCES:
                truncated = True
                break
            occurrences.append(_occurrence(component, recurring_uids))
        except Exception:  # one bad component never kills the feed (ADR 012)
            skipped += 1
    return ParsedFeed(occurrences=tuple(occurrences), skipped=skipped, truncated=truncated)
