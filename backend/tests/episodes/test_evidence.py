"""The evidence card (EP1): fixture ledgers compute exactly (pure, the
roadmap acceptance), and the service reads every episode through the kernel,
cites entity + latest-event ids, writes nothing, and refuses without
``episodes:read``.

Every value here is synthetic — no operator personal content (cell rule).
"""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest

from domains.episodes.capture import guard_capture
from domains.episodes.evidence import METHOD, compute_card, evidence_card
from domains.episodes.types import TYPE_EPISODE, define_episode_types
from kernel import db, services
from kernel.access import AccessContext, ScopeError
from kernel.models import Entity

# --- pure fixture ledgers -------------------------------------------------


def _episode(n: int, **attributes: Any) -> Entity:
    moment = datetime(2026, 1, 1, tzinfo=UTC)
    return Entity(id=UUID(int=n), attributes=attributes, created_at=moment, updated_at=moment)


# Deliberately not in onset order: the card sorts by onset_date itself
# (`find` returns creation order, and a backfilled episode breaks the match).
LEDGER = [
    _episode(  # closed, 5 days, feared 10
        2,
        onset_date="2026-03-10",
        end_date="2026-03-15",
        feared_duration_days=10,
        perturbation_tags=["travel", "conflict"],
    ),
    _episode(  # open: no end_date; its feared value and tag stay out of the math
        5,
        onset_date="2026-05-02",
        feared_duration_days=5,
        perturbation_tags=["travel"],
    ),
    _episode(  # closed, 3 days, feared 14
        1,
        onset_date="2026-03-01",
        end_date="2026-03-04",
        feared_duration_days=14,
        perturbation_tags=["travel", "short-sleep"],
    ),
    _episode(  # closed, 1 day, no feared duration recorded
        4,
        onset_date="2026-04-20",
        end_date="2026-04-21",
        perturbation_tags=["short-sleep"],
    ),
    _episode(  # closed, 2 days, feared 7
        3,
        onset_date="2026-04-01",
        end_date="2026-04-03",
        feared_duration_days=7,
        perturbation_tags=["travel", "short-sleep"],
    ),
]


def test_mixed_ledger_computes_exactly() -> None:
    """Hand-computed: durations in onset order [3, 5, 2, 1] → median 2.5,
    halves [3, 5] vs [2, 1] → 4.0 to 1.5; gaps [-11, -5, -5] → median -5.0."""
    assert compute_card(LEDGER) == {
        "episodes": {"total": 5, "closed": 4, "open": 1},
        "durations": {
            "median_days": 2.5,
            "trend": {
                "direction": "shortening",
                "earlier_median_days": 4.0,
                "later_median_days": 1.5,
            },
        },
        "feared_vs_actual": {
            "compared": 3,
            "median_feared_days": 10.0,
            "median_actual_days": 3.0,
            "median_gap_days": -5.0,
        },
        "perturbation_co_occurrence": [
            {"tags": ["conflict", "travel"], "count": 1},
            {"tags": ["short-sleep", "travel"], "count": 2},
        ],
    }


def test_empty_ledger() -> None:
    assert compute_card([]) == {
        "episodes": {"total": 0, "closed": 0, "open": 0},
        "durations": {"median_days": None, "trend": None},
        "feared_vs_actual": {
            "compared": 0,
            "median_feared_days": None,
            "median_actual_days": None,
            "median_gap_days": None,
        },
        "perturbation_co_occurrence": [],
    }


def test_single_same_day_episode_has_a_median_but_no_trend() -> None:
    """One closed episode: a same-day close is 0 days, and one data point is
    no evidence of a trend — None, not a guess."""
    card = compute_card([_episode(1, onset_date="2026-03-01", end_date="2026-03-01")])
    assert card["episodes"] == {"total": 1, "closed": 1, "open": 0}
    assert card["durations"] == {"median_days": 0.0, "trend": None}


def test_odd_count_trend_drops_the_middle_episode() -> None:
    """Durations [2, 9, 4] in onset order: halves are [2] vs [4] — the middle
    episode is dropped so the halves stay equal — hence lengthening."""
    card = compute_card(
        [
            _episode(1, onset_date="2026-03-01", end_date="2026-03-03"),
            _episode(2, onset_date="2026-03-10", end_date="2026-03-19"),
            _episode(3, onset_date="2026-04-01", end_date="2026-04-05"),
        ]
    )
    assert card["durations"] == {
        "median_days": 4.0,
        "trend": {"direction": "lengthening", "earlier_median_days": 2.0, "later_median_days": 4.0},
    }


def test_equal_halves_are_stable() -> None:
    card = compute_card(
        [
            _episode(1, onset_date="2026-03-01", end_date="2026-03-04"),
            _episode(2, onset_date="2026-03-10", end_date="2026-03-13"),
        ]
    )
    assert card["durations"]["trend"] == {
        "direction": "stable",
        "earlier_median_days": 3.0,
        "later_median_days": 3.0,
    }


def test_open_episodes_count_tags_but_never_durations() -> None:
    """Open episodes are handled explicitly: counted, their recorded
    perturbations are observations already, and no duration is guessed."""
    card = compute_card(
        [
            _episode(1, onset_date="2026-03-01", perturbation_tags=["noise", "heat"]),
            _episode(2, onset_date="2026-03-10", perturbation_tags=["heat", "noise"]),
        ]
    )
    assert card["episodes"] == {"total": 2, "closed": 0, "open": 2}
    assert card["durations"] == {"median_days": None, "trend": None}
    assert card["feared_vs_actual"]["compared"] == 0
    assert card["perturbation_co_occurrence"] == [{"tags": ["heat", "noise"], "count": 2}]


def test_duplicate_tags_within_one_episode_pair_once() -> None:
    card = compute_card(
        [_episode(1, onset_date="2026-03-01", perturbation_tags=["heat", "heat", "noise"])]
    )
    assert card["perturbation_co_occurrence"] == [{"tags": ["heat", "noise"], "count": 1}]


# --- the service against the kernel ---------------------------------------

NOTE = "synthetic retrospective witness"


@pytest.fixture(scope="module", autouse=True)
def episode_types(ctx: AccessContext) -> None:
    define_episode_types(ctx)


def _capture(ctx: AccessContext, attributes: dict[str, Any]) -> services.CaptureResult:
    """The door: guard first, then generic capture — the POST /capture order."""
    guard_capture(ctx, TYPE_EPISODE, attributes)
    return services.capture(ctx, TYPE_EPISODE, attributes)


@pytest.fixture(scope="module")
def seeded(ctx: AccessContext) -> dict[str, UUID]:
    """One episode opened, updated, and closed (three events) plus one open —
    dated and tagged apart from every other module's fixtures."""
    closed = _capture(
        ctx,
        {
            "onset_date": "2027-01-05",
            "perturbation_tags": ["synthetic-noise", "synthetic-light"],
            "intensity": 5,
            "feared_duration_days": 12,
        },
    ).entity_id
    _capture(ctx, {"onset_date": "2027-01-05", "intensity": 3})
    _capture(ctx, {"onset_date": "2027-01-05", "end_date": "2027-01-08", "retro_note": NOTE})
    opened = _capture(
        ctx, {"onset_date": "2027-02-01", "perturbation_tags": ["synthetic-noise"]}
    ).entity_id
    return {"closed": closed, "open": opened}


def event_count() -> int:
    with db.connect() as conn:
        row = conn.execute("select count(*) as n from event").fetchone()
        assert row is not None
        return int(row["n"])


def test_card_covers_every_episode_and_cites_latest_events(
    ctx: AccessContext, seeded: dict[str, UUID]
) -> None:
    """The service is exactly the proven arithmetic over every episode record,
    citing each episode and the event that produced the state it saw."""
    card = evidence_card(ctx)
    episodes = services.find(ctx, type_name=TYPE_EPISODE)

    provenance = card.pop("provenance")
    assert card == compute_card(episodes)
    assert provenance["source_entity_ids"] == [str(e.id) for e in episodes]
    assert provenance["method"] == METHOD and provenance["confidence"] == 1.0
    # one event per cited episode, and it is the LAST one — the merged
    # close-out, not the opening capture
    assert len(provenance["source_event_ids"]) == len(episodes)
    events = services.history(ctx, seeded["closed"])
    assert len(events) == 3
    assert str(events[-1].id) in provenance["source_event_ids"]
    assert str(events[0].id) not in provenance["source_event_ids"]


def test_seeded_fixtures_are_measured(ctx: AccessContext, seeded: dict[str, UUID]) -> None:
    """The seeded pair co-occurs exactly once, and both seeded episodes are
    cited — the closed one measurable, the open one counted."""
    card = evidence_card(ctx)
    assert {"tags": ["synthetic-light", "synthetic-noise"], "count": 1} in card[
        "perturbation_co_occurrence"
    ]
    cited = card["provenance"]["source_entity_ids"]
    assert str(seeded["closed"]) in cited and str(seeded["open"]) in cited
    assert card["episodes"]["open"] >= 1 and card["episodes"]["closed"] >= 1


def test_card_is_pull_only_and_writes_nothing(ctx: AccessContext, seeded: dict[str, UUID]) -> None:
    before = event_count()
    evidence_card(ctx)
    assert event_count() == before


def test_card_requires_episodes_read(seeded: dict[str, UUID]) -> None:
    with pytest.raises(ScopeError):
        evidence_card(AccessContext.of("ops:read"))


def test_card_copies_no_record_text(ctx: AccessContext, seeded: dict[str, UUID]) -> None:
    """IDs and numbers, never note text: a copied note would outlive forget()
    of its episode wherever a caller stored the card (the briefing lesson).
    Perturbation tag names are the one deliberate exception — co-occurrence
    counts of unnamed perturbations would say nothing."""
    assert NOTE not in str(evidence_card(ctx))
