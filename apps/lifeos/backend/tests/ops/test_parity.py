"""Dual-run parity scorecard acceptance tests (#594). Pure, no fixtures."""

from datetime import date, timedelta

import pytest

from domains.ops.parity import Observation, SignOff, score

AS_OF = date(2026, 11, 12)
A = "sha256:" + "a" * 64
B = "sha256:" + "b" * 64


def both(automation: str, day: date, legacy: str = A, local: str = A) -> list[Observation]:
    return [
        Observation(automation, day, "legacy", legacy),
        Observation(automation, day, "local", local),
    ]


def streak(automation: str, days: int, end: date = AS_OF) -> list[Observation]:
    out: list[Observation] = []
    for offset in range(days):
        out += both(automation, end - timedelta(days=offset))
    return out


def test_full_matching_streak_with_recent_signoff_allows_cutover() -> None:
    card = score(
        ["brief"],
        streak("brief", 7),
        [SignOff("brief", AS_OF - timedelta(days=1))],
        as_of=AS_OF,
        streak_days=7,
    )
    assert card.automations[0].verdict == "eligible"
    assert card.automations[0].matched_days == 7
    assert card.cutover_allowed is True


def test_a_gap_or_too_few_days_is_insufficient_never_assumed() -> None:
    gap = [o for o in streak("brief", 7) if o.day != AS_OF - timedelta(days=3)]
    card = score(["brief"], gap, [SignOff("brief", AS_OF)], as_of=AS_OF, streak_days=7)
    assert card.automations[0].verdict == "insufficient"
    assert card.automations[0].missing_days == (AS_OF - timedelta(days=3),)
    assert card.cutover_allowed is False
    short = score(["brief"], streak("brief", 3), [], as_of=AS_OF, streak_days=7)
    assert short.automations[0].verdict == "insufficient"


def test_mismatches_are_reported_with_their_date() -> None:
    """Differing output, a missing side, and a duplicate side are each a dated mismatch."""
    d1, d2, d3 = (AS_OF - timedelta(days=n) for n in (0, 1, 2))
    observations = (
        both("brief", d1, legacy=A, local=B)
        + [Observation("brief", d2, "legacy", A)]
        + both("brief", d3)
        + [Observation("brief", d3, "local", A)]
    )
    card = score(["brief"], observations, [], as_of=AS_OF, streak_days=3)
    result = card.automations[0]
    assert result.verdict == "mismatch"
    assert dict(result.mismatches) == {
        d1: "outputs differ",
        d2: "missing local side",
        d3: "two local observations",
    }


def test_a_signoff_older_than_the_streak_does_not_count() -> None:
    card = score(
        ["brief"],
        streak("brief", 7),
        [SignOff("brief", AS_OF - timedelta(days=30))],
        as_of=AS_OF,
        streak_days=7,
    )
    assert card.automations[0].verdict == "eligible"
    assert card.automations[0].signed_off is False
    assert card.cutover_allowed is False


def test_cutover_needs_every_listed_automation_and_never_an_empty_list() -> None:
    signoffs = [SignOff("brief", AS_OF), SignOff("sync", AS_OF)]
    one_short = score(["brief", "sync"], streak("brief", 7), signoffs, as_of=AS_OF, streak_days=7)
    assert one_short.cutover_allowed is False
    both_ready = score(
        ["brief", "sync"],
        streak("brief", 7) + streak("sync", 7),
        signoffs,
        as_of=AS_OF,
        streak_days=7,
    )
    assert both_ready.cutover_allowed is True
    assert score([], [], [], as_of=AS_OF, streak_days=7).cutover_allowed is False


def test_observations_carry_digests_never_output_text() -> None:
    with pytest.raises(ValueError, match="digest"):
        Observation("brief", AS_OF, "legacy", "Pay the electric bill today")
    with pytest.raises(ValueError, match="side"):
        Observation("brief", AS_OF, "other", A)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="streak_days"):
        score(["brief"], [], [], as_of=AS_OF, streak_days=0)
