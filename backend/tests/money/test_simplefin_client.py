"""Unit: the SimpleFIN Bridge client (roadmap C0).

No live network call anywhere in this module. The access URL is a bearer
credential (username:password embedded in the URL) -- every test here also
proves the credential and the full URL never appear in a raised exception.
"""

import base64
from datetime import date
from typing import Any
from urllib.error import HTTPError

import pytest

from domains.money import simplefin_client as client

ACCESS_URL = "https://user123:sekret-token@bridge.simplefin.org/simplefin"


def test_parse_access_url_extracts_host_and_builds_basic_auth() -> None:
    base, host, auth = client._parse_access_url(ACCESS_URL)
    assert base == "https://bridge.simplefin.org/simplefin"
    assert host == "bridge.simplefin.org"
    expected = "Basic " + base64.b64encode(b"user123:sekret-token").decode()
    assert auth == expected


def test_parse_access_url_rejects_missing_credential() -> None:
    with pytest.raises(client.SimpleFinAuthError):
        client._parse_access_url("https://bridge.simplefin.org/simplefin")


def test_parse_access_url_rejects_non_http_scheme() -> None:
    with pytest.raises(client.SimpleFinAuthError):
        client._parse_access_url("ftp://user:pass@bridge.simplefin.org/simplefin")


def test_parse_access_url_rejects_unparseable_url() -> None:
    with pytest.raises(client.SimpleFinAuthError):
        client._parse_access_url("not a url")


def test_same_host_redirect_is_allowed() -> None:
    guard = client._SameHostRedirects("bridge.simplefin.org")
    req = client.urllib.request.Request("https://bridge.simplefin.org/simplefin/accounts")
    next_req = guard.redirect_request(
        req, None, 302, "Found", {}, "https://bridge.simplefin.org/simplefin/accounts2"
    )
    assert next_req is not None


def test_cross_host_redirect_is_refused() -> None:
    guard = client._SameHostRedirects("bridge.simplefin.org")
    req = client.urllib.request.Request("https://bridge.simplefin.org/simplefin/accounts")
    with pytest.raises(client.SimpleFinError):
        guard.redirect_request(req, None, 302, "Found", {}, "https://evil.example/steal")


def test_scheme_downgrade_redirect_is_refused() -> None:
    guard = client._SameHostRedirects("bridge.simplefin.org")
    req = client.urllib.request.Request("https://bridge.simplefin.org/simplefin/accounts")
    with pytest.raises(client.SimpleFinError):
        guard.redirect_request(req, None, 302, "Found", {}, "ftp://bridge.simplefin.org/steal")


def test_fetch_accounts_returns_the_accounts_list(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {"accounts": [{"id": "ACT-1", "transactions": []}]}

    class FakeResponse:
        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *a: Any) -> None:
            return None

        def read(self, n: int) -> bytes:
            import json

            return json.dumps(payload).encode()

    class FakeOpener:
        def open(self, req: Any, timeout: float) -> Any:
            assert req.get_header("Authorization") is not None
            return FakeResponse()

    monkeypatch.setattr(client.urllib.request, "build_opener", lambda *a, **k: FakeOpener())

    result = client.fetch_accounts(ACCESS_URL, date(2026, 8, 1), date(2026, 8, 5))
    assert result == payload["accounts"]


def test_fetch_accounts_raises_when_accounts_field_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *a: Any) -> None:
            return None

        def read(self, n: int) -> bytes:
            return b'{"errors": ["bad token"]}'

    class FakeOpener:
        def open(self, req: Any, timeout: float) -> Any:
            return FakeResponse()

    monkeypatch.setattr(client.urllib.request, "build_opener", lambda *a, **k: FakeOpener())

    with pytest.raises(client.SimpleFinAuthError):
        client.fetch_accounts(ACCESS_URL, date(2026, 8, 1), date(2026, 8, 5))


def test_fetch_accounts_wraps_network_errors_by_class_name_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A network failure must never leak the access URL or credential --
    both live in the request that failed."""

    class FailingOpener:
        def open(self, req: Any, timeout: float) -> Any:
            raise HTTPError(
                "https://bridge.simplefin.org/simplefin/accounts",
                401,
                f"unauthorized: {ACCESS_URL}",
                {},
                None,
            )

    monkeypatch.setattr(client.urllib.request, "build_opener", lambda *a, **k: FailingOpener())

    with pytest.raises(client.SimpleFinError) as exc_info:
        client.fetch_accounts(ACCESS_URL, date(2026, 8, 1), date(2026, 8, 5))
    assert "sekret-token" not in str(exc_info.value)
    assert ACCESS_URL not in str(exc_info.value)
    assert "HTTPError" in str(exc_info.value)


def test_fetch_accounts_enforces_the_response_size_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *a: Any) -> None:
            return None

        def read(self, n: int) -> bytes:
            return b"x" * (n)  # exactly the +1 bound the client requested

    class FakeOpener:
        def open(self, req: Any, timeout: float) -> Any:
            return FakeResponse()

    monkeypatch.setattr(client.urllib.request, "build_opener", lambda *a, **k: FakeOpener())
    monkeypatch.setattr(client, "MAX_RESPONSE_BYTES", 10)

    with pytest.raises(client.SimpleFinError, match="size bound"):
        client.fetch_accounts(ACCESS_URL, date(2026, 8, 1), date(2026, 8, 5))
