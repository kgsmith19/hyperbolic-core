"""API smoke tests: thin passthrough works end to end."""

from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


@pytest.fixture(scope="module")
def note_type(seeded: object) -> dict[str, Any]:
    response = client.post(
        "/types",
        json={
            "name": "note",
            "domain": "journal",
            "json_schema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
        },
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


def test_capture_get_history_search(note_type: dict[str, Any]) -> None:
    captured = client.post(
        "/capture",
        json={"type_name": "note", "attributes": {"text": "kernel scaffold shipped"}},
    )
    assert captured.status_code == 200, captured.text
    entity_id = captured.json()["entity_id"]
    UUID(entity_id)

    view = client.get(f"/entities/{entity_id}")
    assert view.status_code == 200
    assert view.json()["entity"]["attributes"]["text"] == "kernel scaffold shipped"
    assert view.json()["types"] == ["note"]

    trail = client.get(f"/entities/{entity_id}/history")
    assert trail.status_code == 200
    assert [e["event_type"] for e in trail.json()] == ["entity.created"]

    hits = client.get("/search", params={"type_name": "note", "text": "scaffold"})
    assert hits.status_code == 200
    assert entity_id in {e["id"] for e in hits.json()}


def test_edges_roundtrip(note_type: dict[str, Any]) -> None:
    a = client.post("/capture", json={"type_name": "note", "attributes": {"text": "a"}})
    b = client.post("/capture", json={"type_name": "note", "attributes": {"text": "b"}})
    edge = client.post(
        "/edges",
        json={
            "from_id": a.json()["entity_id"],
            "relation": "references",
            "to_id": b.json()["entity_id"],
            "valid_from": "2026-07-24T00:00:00+00:00",
        },
    )
    assert edge.status_code == 200, edge.text
    assert edge.json()["relation"] == "references"


def test_forget_route_redacts_pii(seeded: dict[str, UUID]) -> None:
    captured = client.post(
        "/capture",
        json={
            "type_name": "person",
            "attributes": {"full_name": "Api Forget", "emails": ["api-forget@example.com"]},
        },
    )
    assert captured.status_code == 200, captured.text
    entity_id = captured.json()["entity_id"]

    forgotten = client.post(f"/entities/{entity_id}/forget", json={})
    assert forgotten.status_code == 200, forgotten.text
    assert set(forgotten.json()["fields"]) == {"full_name", "emails", "birthday"}
    assert "emails" not in client.get(f"/entities/{entity_id}").json()["entity"]["attributes"]

    refused = client.post(f"/entities/{entity_id}/forget", json={"fields": ["shoe_size"]})
    assert refused.status_code == 422


def test_error_mapping(note_type: dict[str, Any]) -> None:
    missing = client.get("/entities/00000000-0000-0000-0000-000000000000")
    assert missing.status_code == 404
    invalid = client.post(
        "/capture", json={"type_name": "note", "attributes": {"text": 5}}
    )
    assert invalid.status_code == 422
