"""Integration: the episode + playbook types (EP1) land as registry data with
``x-sensitive: true`` in their first definition, the capture door enforces the
cell's rules (intensity 0-10, end_date >= onset_date, positive
feared_duration_days, append-only playbook versions), and one episode's
append-only history IS its intensity time series.

Every value here is synthetic — no operator personal content (cell rule).
"""

from datetime import datetime
from typing import Any

import jsonschema
import pytest

from domains.episodes.capture import EpisodeCaptureRefused, guard_capture
from domains.episodes.types import (
    EPISODE_SCHEMA,
    PLAYBOOK_SCHEMA,
    TYPE_EPISODE,
    TYPE_PLAYBOOK,
    define_episode_types,
)
from kernel import services
from kernel.access import AccessContext
from kernel.resolution import Resolution

STEPS_V1 = [
    {"if": "early warning sign", "then": "run the checklist"},
    {"if": "sleep lost", "then": "keep the morning routine anyway"},
]
STEPS_V2 = [{"if": "early warning sign", "then": "run the revised checklist"}]


@pytest.fixture(scope="module", autouse=True)
def episode_types(ctx: AccessContext) -> None:
    define_episode_types(ctx)


def _capture(
    ctx: AccessContext,
    type_name: str,
    attributes: dict[str, Any],
    valid_time: datetime | None = None,
) -> services.CaptureResult:
    """The door: guard first, then generic capture — the POST /capture order."""
    guard_capture(ctx, type_name, attributes)
    return services.capture(ctx, type_name, attributes, valid_time=valid_time)


def test_define_is_idempotent(ctx: AccessContext) -> None:
    assert define_episode_types(ctx) == []


def test_x_sensitive_is_present_from_the_first_definition(ctx: AccessContext) -> None:
    """The schemas that first define both types carry the flag, and so do the
    registry rows they landed as — there is no later migration adding it and
    therefore no window in which the domain was ever LLM-readable."""
    assert EPISODE_SCHEMA["x-sensitive"] is True
    assert PLAYBOOK_SCHEMA["x-sensitive"] is True
    registered = {t.name: t.json_schema for t in services.list_types(ctx)}
    assert registered[TYPE_EPISODE]["x-sensitive"] is True
    assert registered[TYPE_PLAYBOOK]["x-sensitive"] is True


def test_full_episode_capture_accepted(ctx: AccessContext) -> None:
    result = _capture(
        ctx,
        TYPE_EPISODE,
        {
            "onset_date": "2026-01-05",
            "perturbation_tags": ["travel", "short-sleep"],
            "intensity": 6,
            "function_impact": True,
            "feared_duration_days": 14,
        },
    )
    assert result.resolution is Resolution.NEW


def test_intensity_out_of_bounds_rejected(ctx: AccessContext) -> None:
    for bad in (11, -1):
        with pytest.raises(EpisodeCaptureRefused):
            _capture(ctx, TYPE_EPISODE, {"onset_date": "2026-01-06", "intensity": bad})
    # the refusals wrote nothing
    assert services.find(ctx, type_name=TYPE_EPISODE, filters={"onset_date": "2026-01-06"}) == []


def test_boundary_intensities_accepted(ctx: AccessContext) -> None:
    _capture(ctx, TYPE_EPISODE, {"onset_date": "2026-01-07", "intensity": 0})
    _capture(ctx, TYPE_EPISODE, {"onset_date": "2026-01-07", "intensity": 10})


def test_non_positive_feared_duration_rejected(ctx: AccessContext) -> None:
    with pytest.raises(EpisodeCaptureRefused):
        _capture(ctx, TYPE_EPISODE, {"onset_date": "2026-01-08", "feared_duration_days": 0})


def test_fractional_intensity_fails_the_schema(ctx: AccessContext) -> None:
    """In range, so the guard passes it — the 0-10 scale is integers and the
    type definition is what says so."""
    with pytest.raises(jsonschema.ValidationError):
        _capture(ctx, TYPE_EPISODE, {"onset_date": "2026-01-09", "intensity": 7.5})


def test_end_date_before_onset_rejected(ctx: AccessContext) -> None:
    with pytest.raises(EpisodeCaptureRefused):
        _capture(ctx, TYPE_EPISODE, {"onset_date": "2026-01-10", "end_date": "2026-01-09"})


def test_same_day_close_out_accepted_and_merges(ctx: AccessContext) -> None:
    opened = _capture(ctx, TYPE_EPISODE, {"onset_date": "2026-01-11", "intensity": 4})
    closed = _capture(
        ctx,
        TYPE_EPISODE,
        {
            "onset_date": "2026-01-11",
            "end_date": "2026-01-11",
            "retro_note": "shorter than feared",
        },
    )
    assert closed.resolution is Resolution.MATCH
    assert closed.entity_id == opened.entity_id
    [entity] = services.find(ctx, type_name=TYPE_EPISODE, filters={"onset_date": "2026-01-11"})
    # the merge kept the intensity: an update never silently drops a field
    assert entity.attributes["intensity"] == 4
    assert entity.attributes["retro_note"] == "shorter than feared"


def test_a_foreign_type_may_not_carry_the_episode_identity_key() -> None:
    """The PR #49 guard-the-record precedent: a fresh type declaring
    x-identity ["onset_date"] could otherwise merge into an episode."""
    with pytest.raises(EpisodeCaptureRefused):
        guard_capture(
            AccessContext.all(), "calendar_event", {"onset_date": "2026-01-12", "name": "x"}
        )


def test_playbook_versions_append(ctx: AccessContext) -> None:
    v1 = _capture(ctx, TYPE_PLAYBOOK, {"name": "steady days", "version": 1, "steps": STEPS_V1})
    v2 = _capture(ctx, TYPE_PLAYBOOK, {"name": "steady days", "version": 2, "steps": STEPS_V2})
    assert v1.resolution is Resolution.NEW
    assert v2.resolution is Resolution.NEW  # a new version is a new record, never a merge
    assert v1.entity_id != v2.entity_id


def test_recapturing_a_recorded_version_is_refused(ctx: AccessContext) -> None:
    """Append-only: a new version never edits a prior one — re-claiming a
    recorded (name, version) pair is refused and the record stays as written."""
    edited = [{"if": "early warning sign", "then": "something quietly rewritten"}]
    with pytest.raises(EpisodeCaptureRefused):
        _capture(ctx, TYPE_PLAYBOOK, {"name": "steady days", "version": 1, "steps": edited})
    [v1] = services.find(
        ctx, type_name=TYPE_PLAYBOOK, filters={"name": "steady days", "version": 1}
    )
    assert v1.attributes["steps"] == STEPS_V1


def test_playbook_step_missing_its_then_fails_the_schema(ctx: AccessContext) -> None:
    with pytest.raises(jsonschema.ValidationError):
        _capture(
            ctx,
            TYPE_PLAYBOOK,
            {"name": "steady days", "version": 3, "steps": [{"if": "warning sign"}]},
        )


def test_history_of_daily_intensity_updates_is_the_time_series(ctx: AccessContext) -> None:
    """Daily in-episode intensity is a plain entity update through existing
    capture: the append-only history IS the series, no new code involved."""
    first = _capture(ctx, TYPE_EPISODE, {"onset_date": "2026-02-01", "intensity": 4})
    for update in (
        {"onset_date": "2026-02-01", "intensity": 6},
        {"onset_date": "2026-02-01", "intensity": 3, "end_date": "2026-02-03"},
    ):
        result = _capture(ctx, TYPE_EPISODE, update)
        assert result.resolution is Resolution.MATCH
        assert result.entity_id == first.entity_id
    events = services.history(ctx, first.entity_id)
    series = [
        event.payload["entity"]["attributes"]["intensity"]
        for event in events
        if event.event_type in {"entity.created", "entity.updated"}
    ]
    assert series == [4, 6, 3]
