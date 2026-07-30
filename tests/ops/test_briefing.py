"""Integration: the assembled daily briefing (ADR 014, recomposed in INT1).

Everything here is synthetic and dated far from the calendar fixtures, so the
day under test contains exactly what each test put there. Daily test dates are
deliberately not Mondays; the weekly-edition tests use one.
"""

from datetime import UTC, date, datetime, timedelta, timezone
from hashlib import sha256
from typing import Any
from uuid import UUID

import pytest
from psycopg.types.json import Jsonb

from domains.calendar.types import define_calendar_types, email_hash
from domains.episodes.types import define_episode_types
from domains.intentions.focus import capture_intention
from domains.intentions.types import define_intention_types
from domains.ops.briefing import (
    METHOD,
    _optional_find,
    assemble,
    briefing_context,
    main,
    run_briefing,
)
from domains.ops.types import define_ops_types
from kernel import db
from kernel.access import AccessContext, ScopeError
from kernel.services import capture, find, history
from scripts.define_daily_checkin import define_daily_checkin
from scripts.migrate_briefing_composition import migrate

DAY = date(2031, 3, 4)  # a Tuesday: the daily edition
EMPTY_DAY = date(2031, 3, 7)
LEGACY_DAY = date(2031, 5, 2)
WEEKLY_DAY = date(2031, 8, 4)  # a Monday: the weekly edition
TITLE = "Quarterly review with the accountant"
FOCUS_TITLE = "Briefing focus A"

# The composition B3 shipped (ADR 014; value constraints elided), which an
# un-migrated database still enforces: reviews and a check-in pointer in,
# focus intentions out.
OLD_BRIEFING_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "briefing_key": {"type": "string", "maxLength": 32},
        "date": {"type": "string", "maxLength": 32},
        "appointment_ids": {"type": "array", "items": {"type": "string"}},
        "open_review_ids": {"type": "array", "items": {"type": "string"}},
        "latest_checkin_id": {"type": "string"},
        "provenance": {"type": "object"},
    },
    "required": ["briefing_key", "date", "appointment_ids", "open_review_ids", "provenance"],
    "additionalProperties": False,
    "x-identity": ["briefing_key"],
}


@pytest.fixture(scope="module")
def brief_ctx(ctx: AccessContext) -> AccessContext:
    """The exact production context; `ctx` (all scopes) only arranges data."""
    define_calendar_types(ctx)
    define_intention_types(ctx)
    define_daily_checkin(ctx)
    context = briefing_context()
    define_ops_types(context)
    return context


@pytest.fixture(scope="module")
def focus_goals(ctx: AccessContext, brief_ctx: AccessContext) -> list[str]:
    """Three focus intentions (ids sorted by title) plus one backlog item.

    Clears any focus flag left behind by earlier test modules first, so the
    assertions below are exact whatever order the session ran in.
    """
    for entity in find(ctx, type_name="intention", filters={"focus": True}):
        capture_intention(ctx, {**entity.attributes, "focus": False})
    goals = [
        {
            "title": FOCUS_TITLE,
            "kind": "project",
            "status": "active",
            "focus": True,
            "floor": "the floor version",
            "next_action": "the next physical action",
        },
        {"title": "Briefing focus B", "kind": "habit_quota", "status": "active", "focus": True},
        {"title": "Briefing focus C", "kind": "task", "status": "active", "focus": True},
    ]
    ids = [str(capture_intention(ctx, goal).entity_id) for goal in goals]
    backlog = {"title": "Briefing backlog", "kind": "task", "status": "someday", "focus": False}
    capture_intention(ctx, backlog)
    return ids


def make_appointment(ctx: AccessContext, key: str, starts_at: str) -> UUID:
    return capture(
        ctx,
        "appointment",
        {
            "ics_key": key,
            "uid": key,
            "title": TITLE,
            "starts_at": starts_at,
            "vevent_hash": sha256(key.encode()).hexdigest(),
        },
    ).entity_id


def make_checkin(ctx: AccessContext, on: date) -> UUID:
    return capture(
        ctx,
        "daily_checkin",
        {"date": on.isoformat(), "mood": 3, "energy": 3, "stress": 3, "sleep_quality": 3},
    ).entity_id


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def stored(ctx: AccessContext, day: date) -> dict[str, Any]:
    (briefing,) = find(ctx, type_name="briefing", filters={"briefing_key": day.isoformat()})
    return {"id": briefing.id, **briefing.attributes}


def test_briefing_lists_todays_appointments_chronologically(
    ctx: AccessContext, brief_ctx: AccessContext
) -> None:
    late = make_appointment(ctx, "brief-late", "2031-03-04T16:00:00+00:00")
    early = make_appointment(ctx, "brief-early", "2031-03-04T09:00:00+00:00")
    make_appointment(ctx, "brief-tomorrow", "2031-03-05T09:00:00+00:00")

    report = run_briefing(brief_ctx, DAY, UTC)

    assert report.appointments == 2 and not report.unchanged
    assert stored(brief_ctx, DAY)["appointment_ids"] == [str(early), str(late)]


def test_focus_intentions_lead_the_digest(
    ctx: AccessContext, brief_ctx: AccessContext, focus_goals: list[str]
) -> None:
    """Roadmap §INT1 composition: the (at most three, service-enforced) focus
    intentions come first, cited with provenance; the backlog stays out."""
    report = run_briefing(brief_ctx, DAY, UTC)
    attributes = stored(brief_ctx, DAY)

    assert report.focus == 3
    assert attributes["focus_intention_ids"] == focus_goals
    provenance = attributes["provenance"]
    assert provenance["method"] == METHOD and provenance["confidence"] == 1.0
    assert set(focus_goals) <= set(provenance["source_entity_ids"])
    # every cited entity contributes the event that produced the state we saw
    assert len(provenance["source_event_ids"]) == len(provenance["source_entity_ids"])


def test_daily_digest_carries_nothing_else(
    ctx: AccessContext, brief_ctx: AccessContext, focus_goals: list[str]
) -> None:
    """Feelings are pull-only and the digest is focus + calendar + nothing else
    (roadmap §INT1, ADR 019 rules 1/2): an open link_review and a same-day
    check-in exist, and neither enters the briefing; a Tuesday carries no gate."""
    review = capture(
        ctx,
        "link_review",
        {
            "review_key": "briefing-fixture:ambiguous_email_match",
            "attendee_id": str(UUID(int=7)),
            "candidate_person_ids": [],
            "reason": "ambiguous_email_match",
        },
    ).entity_id
    checkin = make_checkin(ctx, DAY)

    run_briefing(brief_ctx, DAY, UTC)
    attributes = stored(brief_ctx, DAY)

    assert "open_review_ids" not in attributes and "latest_checkin_id" not in attributes
    assert "gate" not in attributes
    cited = attributes["provenance"]["source_entity_ids"]
    assert str(review) not in cited and str(checkin) not in cited


def test_briefing_copies_no_third_party_text(
    ctx: AccessContext, brief_ctx: AccessContext, focus_goals: list[str]
) -> None:
    witness = "briefing-witness@fixture.test"
    capture(
        ctx, "attendee", {"email_hash": email_hash(witness), "email": witness, "name": "B Witness"}
    )
    make_appointment(ctx, "brief-pii", "2031-03-04T11:00:00+00:00")
    run_briefing(brief_ctx, DAY, UTC)
    briefing = stored(brief_ctx, DAY)

    # IDs, never the text they point at: a copied title, floor or next action
    # would survive the erasure of its entity (invariant 9, ADR 012/014)
    body = str({k: v for k, v in briefing.items() if k != "id"})
    assert TITLE not in body
    assert FOCUS_TITLE not in body and "the floor version" not in body
    assert "briefing-witness@fixture.test" not in body
    # and the briefing never surfaces on the appointment's own text search
    assert briefing["id"] not in {e.id for e in find(brief_ctx, text=TITLE)}


def test_rerun_with_unchanged_inputs_emits_nothing(brief_ctx: AccessContext) -> None:
    run_briefing(brief_ctx, DAY, UTC)
    before = event_count()
    report = run_briefing(brief_ctx, DAY, UTC)
    assert report.unchanged
    assert event_count() == before  # the idempotency proof


def test_new_appointment_updates_the_same_briefing(
    ctx: AccessContext, brief_ctx: AccessContext
) -> None:
    first = run_briefing(brief_ctx, DAY, UTC)
    make_appointment(ctx, "brief-added", "2031-03-04T20:00:00+00:00")

    second = run_briefing(brief_ctx, DAY, UTC)

    assert second.briefing_id == first.briefing_id and not second.unchanged
    assert second.appointments == first.appointments + 1
    events = [e.event_type for e in history(brief_ctx, second.briefing_id)]
    assert events[0] == "entity.created" and "entity.updated" in events  # supersede, not overwrite


def test_local_timezone_decides_the_day(ctx: AccessContext, brief_ctx: AccessContext) -> None:
    # 01:30 UTC on the 6th is still the evening of the 5th, five hours west
    appointment = make_appointment(ctx, "brief-tz", "2031-03-06T01:30:00+00:00")
    west = timezone(timedelta(hours=-5))

    assert str(appointment) in assemble(brief_ctx, date(2031, 3, 5), west)["appointment_ids"]
    assert str(appointment) not in assemble(brief_ctx, date(2031, 3, 6), west)["appointment_ids"]
    assert str(appointment) in assemble(brief_ctx, date(2031, 3, 6), UTC)["appointment_ids"]


@pytest.fixture(scope="module")
def gate_checkins(ctx: AccessContext, brief_ctx: AccessContext) -> list[UUID]:
    """Check-ins on 5/5/4/5 days of the four complete weeks before WEEKLY_DAY,
    plus two just outside the window that must never be counted."""
    window_start = WEEKLY_DAY - timedelta(days=28)
    counted = [
        make_checkin(ctx, window_start + timedelta(days=7 * week + day))
        for week, days in enumerate((5, 5, 4, 5))
        for day in range(days)
    ]
    make_checkin(ctx, window_start - timedelta(days=1))  # before the window
    make_checkin(ctx, WEEKLY_DAY)  # the Monday itself is not a complete week
    return counted


def test_monday_edition_reports_gate_status(
    ctx: AccessContext, brief_ctx: AccessContext, focus_goals: list[str], gate_checkins: list[UUID]
) -> None:
    """ADR 019 rule 9: per-week days-of-use counts over the four complete weeks
    behind the Monday, computed from kernel data — counts and a boolean,
    restart-neutral, citing the check-ins it counted."""
    report = run_briefing(brief_ctx, WEEKLY_DAY, UTC)
    attributes = stored(brief_ctx, WEEKLY_DAY)

    assert attributes["gate"] == {"weeks": [5, 5, 4, 5], "met": False}
    assert report.gate == "open" and "gate=open" in report.line()
    cited = set(attributes["provenance"]["source_entity_ids"])
    assert {str(c) for c in gate_checkins} <= cited
    assert len(cited) == len(focus_goals) + len(gate_checkins)  # nothing outside the window


def test_gate_met_when_every_week_reaches_five_days(
    ctx: AccessContext, brief_ctx: AccessContext, focus_goals: list[str], gate_checkins: list[UUID]
) -> None:
    # the missing fifth day of the third week
    make_checkin(ctx, WEEKLY_DAY - timedelta(days=28) + timedelta(days=7 * 2 + 4))

    report = run_briefing(brief_ctx, WEEKLY_DAY, UTC)

    assert report.gate == "met" and "gate=met" in report.line()
    assert stored(brief_ctx, WEEKLY_DAY)["gate"] == {"weeks": [5, 5, 5, 5], "met": True}


def test_migration_then_merge_over_an_old_composition_briefing(
    ctx: AccessContext, brief_ctx: AccessContext, focus_goals: list[str]
) -> None:
    """An existing database keeps B3's schema until the operator runs
    `scripts/migrate_briefing_composition.py`; the first recomposed run then
    merges onto the stored briefing, whose stale keys linger without defeating
    idempotency."""
    with db.connect() as conn:
        conn.execute(
            "update type_definition set json_schema = %s where name = 'briefing'",
            (Jsonb(OLD_BRIEFING_SCHEMA),),
        )
    try:
        capture(
            ctx,
            "briefing",
            {
                "briefing_key": LEGACY_DAY.isoformat(),
                "date": LEGACY_DAY.isoformat(),
                "appointment_ids": [],
                "open_review_ids": [str(UUID(int=9))],
                "provenance": {
                    "source_entity_ids": [],
                    "source_event_ids": [],
                    "method": METHOD,
                    "confidence": 1.0,
                },
            },
            actor=METHOD,
        )
    finally:
        assert migrate() == {"types_updated": 1}  # restores the INT1 schema

    first = run_briefing(brief_ctx, LEGACY_DAY, UTC)
    attributes = stored(brief_ctx, LEGACY_DAY)
    assert not first.unchanged
    assert attributes["focus_intention_ids"] == focus_goals
    assert attributes["open_review_ids"] == [str(UUID(int=9))]  # lingers on the merged entity

    before = event_count()
    assert run_briefing(brief_ctx, LEGACY_DAY, UTC).unchanged  # the lingering key is ignored
    assert event_count() == before
    assert migrate() == {"types_updated": 0}  # second migration run: no-op


EPISODE_DAY = date(2032, 6, 9)  # a Wednesday; only this module's episodes land in its week
NO_EPISODE_DAY = date(2032, 9, 1)


@pytest.fixture(scope="module")
def episode_week(ctx: AccessContext, brief_ctx: AccessContext) -> list[UUID]:
    """Synthetic episodes making two tags usual (>= 2 episodes each) and
    present in EPISODE_DAY's week, plus a one-off tag that must not count.
    2032-* onset dates: nothing merges with other modules (identity)."""
    define_episode_types(ctx)
    history = capture(
        ctx,
        "episode",
        {"onset_date": "2032-01-10", "perturbation_tags": ["brief-tag-a", "brief-tag-b"]},
    ).entity_id
    in_week = [
        capture(
            ctx, "episode", {"onset_date": "2032-06-04", "perturbation_tags": ["brief-tag-a"]}
        ).entity_id,
        capture(
            ctx,
            "episode",
            {"onset_date": "2032-06-07", "perturbation_tags": ["brief-tag-b", "brief-tag-once"]},
        ).entity_id,
    ]
    return [history, *in_week]


def test_briefing_carries_one_descriptive_episodes_line(
    ctx: AccessContext, brief_ctx: AccessContext, episode_week: list[UUID]
) -> None:
    """Roadmap §EP1: ONE line, historical language, a count in words — never a
    tag name — and the contributing episodes cited like every other section."""
    run_briefing(brief_ctx, EPISODE_DAY, UTC)
    attributes = stored(brief_ctx, EPISODE_DAY)

    assert attributes["episodes_line"] == "2 of your usual perturbations present this week"
    assert "brief-tag" not in str(attributes)  # counts only: no tag text anywhere
    provenance = attributes["provenance"]
    assert {str(i) for i in episode_week} <= set(provenance["source_entity_ids"])
    assert len(provenance["source_event_ids"]) == len(provenance["source_entity_ids"])


def test_briefing_without_usual_perturbations_has_no_episodes_line(
    brief_ctx: AccessContext, episode_week: list[UUID]
) -> None:
    """Zero is silence, not a zero-count line: a daily '0 of your usual...'
    would put episode salience on a schedule (the episodes cell is pull-only)."""
    run_briefing(brief_ctx, NO_EPISODE_DAY, UTC)
    assert "episodes_line" not in stored(brief_ctx, NO_EPISODE_DAY)


def test_briefing_context_reads_episodes_without_write() -> None:
    scopes = briefing_context().scopes
    assert "episodes:read" in scopes and "episodes:write" not in scopes


def test_absent_type_is_an_empty_section_not_a_crash(brief_ctx: AccessContext) -> None:
    assert _optional_find(brief_ctx, "no_such_type_yet") == []


def test_scoped_out_type_refuses_rather_than_composing_empty(brief_ctx: AccessContext) -> None:
    """Visibility is not existence (the PR #49 precedent): a DEFINED type the
    context cannot read is a ScopeError, never a silently empty section — a
    mis-built context must crash the run, not hollow out the digest."""
    with pytest.raises(ScopeError):
        _optional_find(AccessContext.of("ops:read"), "intention")


def test_briefing_cannot_write_what_it_reads(
    brief_ctx: AccessContext, episode_week: list[UUID]
) -> None:
    with pytest.raises(ScopeError):  # read-only on calendar by construction
        make_appointment(brief_ctx, "brief-forbidden", "2031-03-04T12:00:00+00:00")
    with pytest.raises(ScopeError):  # and read-only on intentions
        capture_intention(
            brief_ctx, {"title": "Forbidden", "kind": "task", "status": "active", "focus": False}
        )
    with pytest.raises(ScopeError):  # and read-only on episodes (EP1)
        capture(brief_ctx, "episode", {"onset_date": "2032-12-01"})


def test_briefing_without_ops_write_fails_closed() -> None:
    read_only = AccessContext.of("intentions:read", "calendar:read", "wellbeing:read", "ops:read")
    with pytest.raises(ScopeError):
        run_briefing(read_only, EMPTY_DAY, UTC)


def test_cli_emits_an_execution_receipt(brief_ctx: AccessContext) -> None:
    assert main() == 0
    receipts = find(brief_ctx, type_name="execution_receipt", filters={"job": METHOD})
    assert receipts and receipts[-1].attributes["status"] == "ok"
    today = datetime.now(UTC).date().isoformat()
    assert receipts[-1].attributes["summary"].startswith(f"briefing {today}")
