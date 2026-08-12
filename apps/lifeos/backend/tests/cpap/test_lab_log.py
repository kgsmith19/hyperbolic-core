"""Unit: the lab_log registry rider's pure helpers (roadmap H2)."""

from datetime import date, timedelta

from domains.cpap.lab_log import lab_key, next_due


def test_lab_key_is_stable_for_the_same_name_and_date() -> None:
    assert lab_key("A1C", date(2026, 1, 1)) == lab_key("a1c", date(2026, 1, 1))  # case-insensitive
    assert lab_key(" A1C ", date(2026, 1, 1)) == lab_key("A1C", date(2026, 1, 1))  # trimmed


def test_lab_key_differs_by_name_or_date() -> None:
    base = lab_key("A1C", date(2026, 1, 1))
    assert lab_key("Lipid Panel", date(2026, 1, 1)) != base
    assert lab_key("A1C", date(2026, 2, 1)) != base


def test_next_due_is_none_with_no_logged_draws() -> None:
    assert next_due([], "A1C") is None


def test_next_due_ignores_other_labs() -> None:
    logs = [{"lab_name": "Lipid Panel", "date": "2026-01-01", "cadence_days": 90}]
    assert next_due(logs, "A1C") is None


def test_next_due_is_the_latest_draw_plus_its_cadence() -> None:
    logs = [
        {"lab_name": "A1C", "date": "2026-01-01", "cadence_days": 90},
        {"lab_name": "A1C", "date": "2026-04-01", "cadence_days": 90},  # the latest draw
    ]
    assert next_due(logs, "A1C") == date(2026, 4, 1) + timedelta(days=90)


def test_next_due_is_none_when_the_latest_draw_carries_no_cadence() -> None:
    logs = [{"lab_name": "A1C", "date": "2026-01-01"}]
    assert next_due(logs, "A1C") is None
