"""Source payloads map to planner records or fail closed (#572)."""

from datetime import UTC, datetime

import pytest

from kernel.sync_sources import drive_file_record, google_task_record


def test_drive_file_maps_to_a_utc_record_keyed_by_its_id() -> None:
    record = drive_file_record(
        {"id": "1dGREu", "name": "Operations Registry", "modifiedTime": "2026-11-11T10:15:59.761Z"}
    )
    assert (record.source, record.external_id, record.title) == (
        "google-drive",
        "1dGREu",
        "Operations Registry",
    )
    assert record.updated_at == datetime(2026, 11, 11, 10, 15, 59, 761000, tzinfo=UTC)


def test_google_task_maps_to_a_record_in_its_own_source() -> None:
    record = google_task_record(
        {"id": "t-7", "title": "File claim", "updated": "2026-11-11T09:00:00+00:00"}
    )
    assert (record.source, record.external_id) == ("google-tasks", "t-7")


def test_missing_identity_fails_closed() -> None:
    with pytest.raises(ValueError):
        google_task_record({"title": "no id", "updated": "2026-11-11T09:00:00Z"})


def test_blank_title_fails_closed() -> None:
    with pytest.raises(ValueError):
        drive_file_record({"id": "x", "name": "   ", "modifiedTime": "2026-11-11T09:00:00Z"})


def test_naive_timestamp_fails_closed_instead_of_guessing_a_zone() -> None:
    with pytest.raises(ValueError):
        google_task_record({"id": "t", "title": "t", "updated": "2026-11-11T09:00:00"})
