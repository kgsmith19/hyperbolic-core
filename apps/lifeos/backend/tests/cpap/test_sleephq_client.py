"""Unit: the SleepHQ OAuth2 client (roadmap H2).

No live network call anywhere in this module: `_request_json` is
monkeypatched for the happy/error paths, and the redirect guard is exercised
directly against `urllib.request.HTTPRedirectHandler`'s own call shape.
"""

from datetime import date
from typing import Any
from urllib.error import HTTPError

import pytest

from domains.cpap import sleephq_client as client


def test_same_host_redirect_is_allowed() -> None:
    guard = client._SameHostRedirects("sleephq.com")
    req = client.urllib.request.Request("https://sleephq.com/oauth/token")
    # Constructing the next request must not raise for a same-host redirect.
    next_req = guard.redirect_request(
        req, None, 302, "Found", {}, "https://sleephq.com/oauth/token2"
    )
    assert next_req is not None


def test_cross_host_redirect_is_refused() -> None:
    guard = client._SameHostRedirects("sleephq.com")
    req = client.urllib.request.Request("https://sleephq.com/oauth/token")
    with pytest.raises(client.SleepHQError):
        guard.redirect_request(req, None, 302, "Found", {}, "https://evil.example/steal")


def test_scheme_downgrade_redirect_is_refused() -> None:
    guard = client._SameHostRedirects("sleephq.com")
    req = client.urllib.request.Request("https://sleephq.com/oauth/token")
    with pytest.raises(client.SleepHQError):
        guard.redirect_request(req, None, 302, "Found", {}, "ftp://sleephq.com/oauth/token")


def test_opener_refuses_an_unparseable_base_url() -> None:
    with pytest.raises(client.SleepHQError):
        client._opener("not-a-url")


def test_fetch_access_token_returns_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client, "_request_json", lambda *a, **k: {"access_token": "tok-123"})
    assert client.fetch_access_token("id", "secret", "https://sleephq.com") == "tok-123"


def test_fetch_access_token_raises_on_missing_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client, "_request_json", lambda *a, **k: {"error": "invalid_client"})
    with pytest.raises(client.SleepHQAuthError):
        client.fetch_access_token("id", "wrong-secret", "https://sleephq.com")


def test_fetch_team_id_returns_current_team_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        client,
        "_request_json",
        lambda *a, **k: {"data": {"attributes": {"current_team_id": 42}}},
    )
    assert client.fetch_team_id("tok", "https://sleephq.com") == "42"


def test_fetch_team_id_raises_when_team_id_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client, "_request_json", lambda *a, **k: {"data": {"attributes": {}}})
    with pytest.raises(client.SleepHQAuthError):
        client.fetch_team_id("tok", "https://sleephq.com")


def test_fetch_nights_returns_the_data_array(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = [{"id": "1", "attributes": {"date": "2026-08-01"}}]
    monkeypatch.setattr(client, "_request_json", lambda *a, **k: {"data": payload})

    result = client.fetch_nights(
        "tok", "https://sleephq.com", "42", date(2026, 8, 1), date(2026, 8, 1)
    )
    assert result == payload


def test_fetch_nights_returns_empty_list_when_data_is_not_a_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(client, "_request_json", lambda *a, **k: {"data": None})

    result = client.fetch_nights(
        "tok", "https://sleephq.com", "42", date(2026, 8, 1), date(2026, 8, 1)
    )
    assert result == []


def test_request_json_wraps_network_errors_by_class_name_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A network failure must never leak into the exception message -- the
    request carries a bearer token / client secret in its body or headers."""

    class FailingOpener:
        def open(self, req: Any, timeout: float) -> Any:
            raise HTTPError(
                "https://sleephq.com/oauth/token", 401, "unauthorized: secret=abc", {}, None
            )

    monkeypatch.setattr(client, "_opener", lambda base_url: FailingOpener())
    with pytest.raises(client.SleepHQError) as exc_info:
        client._request_json(
            "https://sleephq.com", "/oauth/token", method="POST", headers={}, body=b"{}"
        )
    assert "secret=abc" not in str(exc_info.value)
    assert "HTTPError" in str(exc_info.value)
