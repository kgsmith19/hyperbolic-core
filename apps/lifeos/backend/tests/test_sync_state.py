"""The applied-state store never lets a stale source overwrite newer applied state (#572)."""

from datetime import UTC, datetime

import pytest

from kernel import db
from kernel.sync_state import StaleWrite, applied_map, last_applied, record_applied

T0 = datetime(2026, 11, 1, 9, 0, tzinfo=UTC)
T1 = datetime(2026, 11, 1, 10, 0, tzinfo=UTC)


def test_unknown_identifier_has_no_applied_state() -> None:
    with db.connect() as conn:
        assert last_applied(conn, "google-tasks", "never-seen") is None


def test_recorded_timestamp_round_trips() -> None:
    with db.connect() as conn:
        record_applied(conn, "google-tasks", "round-trip", T0)
        assert last_applied(conn, "google-tasks", "round-trip") == T0


def test_newer_timestamp_advances_the_recorded_state() -> None:
    with db.connect() as conn:
        record_applied(conn, "google-tasks", "advance", T0)
        record_applied(conn, "google-tasks", "advance", T1)
        assert last_applied(conn, "google-tasks", "advance") == T1


def test_same_timestamp_is_a_harmless_rerun() -> None:
    with db.connect() as conn:
        record_applied(conn, "google-tasks", "rerun", T0)
        record_applied(conn, "google-tasks", "rerun", T0)
        assert last_applied(conn, "google-tasks", "rerun") == T0


def test_older_timestamp_is_refused_and_leaves_newer_state_intact() -> None:
    with db.connect() as conn:
        record_applied(conn, "google-tasks", "stale", T1)
        with pytest.raises(StaleWrite):
            record_applied(conn, "google-tasks", "stale", T0)
        assert last_applied(conn, "google-tasks", "stale") == T1


def test_same_external_id_in_two_sources_keeps_separate_state() -> None:
    with db.connect() as conn:
        record_applied(conn, "operations-registry", "P-02", T0)
        record_applied(conn, "execution-registry", "P-02", T1)
        assert last_applied(conn, "operations-registry", "P-02") == T0
        assert last_applied(conn, "execution-registry", "P-02") == T1


def test_applied_map_feeds_the_planner_shape() -> None:
    with db.connect() as conn:
        record_applied(conn, "google-tasks", "map-me", T0)
        assert applied_map(conn)[("google-tasks", "map-me")] == T0
