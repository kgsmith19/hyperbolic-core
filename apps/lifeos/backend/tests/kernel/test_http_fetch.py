"""Unit: the shared same-host-redirect fetch helpers (issue #104).

No live network call anywhere in this module -- these are pure unit tests
over the SSRF guard and the bounded-read/JSON-shape helpers that
domains.calendar.ingest, domains.cpap.sleephq_client and
domains.money.simplefin_client now all build on.
"""

import urllib.request
from typing import Any

import pytest

from kernel.http_fetch import SameHostRedirects, fetch_bounded, fetch_json_object


def test_same_host_redirect_is_allowed() -> None:
    guard = SameHostRedirects("example.test")
    request = urllib.request.Request("https://example.test/a")
    next_req = guard.redirect_request(request, None, 302, "Found", {}, "https://example.test/b")
    assert next_req is not None


def test_cross_host_redirect_is_refused_with_default_error() -> None:
    guard = SameHostRedirects("example.test")
    request = urllib.request.Request("https://example.test/a")
    with pytest.raises(ValueError, match="redirect"):
        guard.redirect_request(request, None, 302, "Found", {}, "https://evil.test/steal")


def test_scheme_downgrade_redirect_is_refused() -> None:
    guard = SameHostRedirects("example.test")
    request = urllib.request.Request("https://example.test/a")
    with pytest.raises(ValueError, match="redirect"):
        guard.redirect_request(request, None, 302, "Found", {}, "ftp://example.test/a")


def test_subclass_can_override_reject_error() -> None:
    class BoomError(RuntimeError):
        pass

    class CustomGuard(SameHostRedirects):
        def reject(self, hostname: str | None) -> Exception:
            return BoomError(f"nope: {hostname}")

    guard = CustomGuard("example.test")
    request = urllib.request.Request("https://example.test/a")
    with pytest.raises(BoomError, match="nope: evil.test"):
        guard.redirect_request(request, None, 302, "Found", {}, "https://evil.test/steal")


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *a: Any) -> None:
        return None

    def read(self, n: int) -> bytes:
        return self._body[:n]


class _FakeOpener:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def open(self, req: Any, timeout: float) -> Any:
        return _FakeResponse(self._body)


def test_fetch_bounded_returns_body_within_bound() -> None:
    opener = _FakeOpener(b"hello")
    result = fetch_bounded(
        opener, "https://example.test/a", timeout=1, max_bytes=10, oversize_error=ValueError("x")
    )
    assert result == b"hello"


def test_fetch_bounded_raises_oversize_error_when_body_exceeds_bound() -> None:
    opener = _FakeOpener(b"x" * 20)
    oversize = ValueError("too big")
    with pytest.raises(ValueError, match="too big"):
        fetch_bounded(
            opener, "https://example.test/a", timeout=1, max_bytes=10, oversize_error=oversize
        )


def test_fetch_json_object_parses_a_json_dict() -> None:
    opener = _FakeOpener(b'{"a": 1}')
    result = fetch_json_object(
        opener,
        "https://example.test/a",
        timeout=1,
        max_bytes=100,
        oversize_error=ValueError("oversize"),
        invalid_json_error=ValueError("bad json"),
        not_object_error=ValueError("not object"),
    )
    assert result == {"a": 1}


def test_fetch_json_object_raises_invalid_json_error_on_bad_json() -> None:
    opener = _FakeOpener(b"not json")
    with pytest.raises(ValueError, match="bad json"):
        fetch_json_object(
            opener,
            "https://example.test/a",
            timeout=1,
            max_bytes=100,
            oversize_error=ValueError("oversize"),
            invalid_json_error=ValueError("bad json"),
            not_object_error=ValueError("not object"),
        )


def test_fetch_json_object_raises_not_object_error_on_json_array() -> None:
    opener = _FakeOpener(b"[1, 2, 3]")
    with pytest.raises(ValueError, match="not object"):
        fetch_json_object(
            opener,
            "https://example.test/a",
            timeout=1,
            max_bytes=100,
            oversize_error=ValueError("oversize"),
            invalid_json_error=ValueError("bad json"),
            not_object_error=ValueError("not object"),
        )
