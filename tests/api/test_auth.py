"""Token verification: the API refuses everything but the owner's valid
ES256 Supabase JWT, and a scopes claim narrows the AccessContext."""

import os
import time
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from starlette.requests import Request

from api import auth
from api.main import app
from kernel.access import ALL_SCOPES

SUPABASE_URL = "https://project.supabase.co"
ISSUER = f"{SUPABASE_URL}/auth/v1"
OWNER = "11111111-1111-1111-1111-111111111111"

_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
_PUBLIC_KEY = _PRIVATE_KEY.public_key()
_OTHER_KEY = ec.generate_private_key(ec.SECP256R1())


@pytest.fixture(autouse=True)
def supabase_mode(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("LIFEOS_AUTH_MODE", "supabase")
    monkeypatch.setenv("LIFEOS_SUPABASE_URL", SUPABASE_URL)
    monkeypatch.setenv("LIFEOS_OWNER_USER_ID", OWNER)
    # Env vars only — a developer's repo .env must not leak into these tests.
    monkeypatch.setattr(auth, "read_env", lambda name: os.environ.get(name))
    stub = SimpleNamespace(get_signing_key_from_jwt=lambda token: SimpleNamespace(key=_PUBLIC_KEY))
    monkeypatch.setattr(auth, "_jwks_client", lambda url: stub)
    yield


def make_token(key: Any = _PRIVATE_KEY, **overrides: Any) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "sub": OWNER,
        "aud": "authenticated",
        "iss": ISSUER,
        "iat": now,
        "exp": now + 300,
    }
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="ES256", headers={"kid": "test-key"})


def request_with(token: str | None) -> Request:
    headers = [] if token is None else [(b"authorization", b"Bearer " + token.encode())]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers})


def test_valid_token_grants_all_scopes() -> None:
    context = auth.authenticate(request_with(make_token()))
    assert context.scopes == frozenset({ALL_SCOPES})


def test_scopes_claim_narrows_context() -> None:
    context = auth.authenticate(request_with(make_token(scopes=["journal:read"])))
    assert context.scopes == frozenset({"journal:read"})


@pytest.mark.parametrize("scopes", ["journal:read", [1, 2], {"a": 1}])
def test_malformed_scopes_rejected(scopes: Any) -> None:
    with pytest.raises(auth.AuthError, match="scopes"):
        auth.authenticate(request_with(make_token(scopes=scopes)))


@pytest.mark.parametrize("scopes", [["*"], ["bills:*"], ["*:write"], ["journal:read", "*"]])
def test_wildcard_scopes_rejected(scopes: list[str]) -> None:
    """A scopes claim VALUE asserting everything must not become the owner
    context — only the absence of the claim grants that (ADR 018)."""
    with pytest.raises(auth.AuthError, match="wildcard"):
        auth.authenticate(request_with(make_token(scopes=scopes)))


def test_missing_header_rejected() -> None:
    with pytest.raises(auth.AuthError, match="missing"):
        auth.authenticate(request_with(None))


def test_non_bearer_header_rejected() -> None:
    request = Request({"type": "http", "headers": [(b"authorization", b"Basic abc")]})
    with pytest.raises(auth.AuthError, match="bearer"):
        auth.authenticate(request)


def test_expired_token_rejected() -> None:
    now = int(time.time())
    with pytest.raises(auth.AuthError, match="invalid token"):
        auth.authenticate(request_with(make_token(iat=now - 600, exp=now - 300)))


def test_wrong_subject_rejected() -> None:
    token = make_token(sub="22222222-2222-2222-2222-222222222222")
    with pytest.raises(auth.AuthError, match="unknown subject"):
        auth.authenticate(request_with(token))


def test_wrong_audience_rejected() -> None:
    with pytest.raises(auth.AuthError, match="invalid token"):
        auth.authenticate(request_with(make_token(aud="anon")))


def test_wrong_issuer_rejected() -> None:
    token = make_token(iss="https://evil.example.com/auth/v1")
    with pytest.raises(auth.AuthError, match="invalid token"):
        auth.authenticate(request_with(token))


def test_wrong_key_rejected() -> None:
    with pytest.raises(auth.AuthError, match="invalid token"):
        auth.authenticate(request_with(make_token(key=_OTHER_KEY)))


def test_symmetric_algorithm_rejected() -> None:
    now = int(time.time())
    claims = {"sub": OWNER, "aud": "authenticated", "iss": ISSUER, "iat": now, "exp": now + 300}
    token = jwt.encode(claims, "not-a-real-secret", algorithm="HS256")
    with pytest.raises(auth.AuthError, match="invalid token"):
        auth.authenticate(request_with(token))


def test_disabled_mode_allows_all(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LIFEOS_AUTH_MODE", "disabled")
    context = auth.authenticate(request_with(None))
    assert context.scopes == frozenset({ALL_SCOPES})


def test_enabled_without_config_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LIFEOS_SUPABASE_URL")
    with pytest.raises(RuntimeError, match="auth is enabled"):
        auth.settings()


def test_route_rejects_request_without_token() -> None:
    client = TestClient(app)
    response = client.get("/search")
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    forged = make_token(key=_OTHER_KEY)
    response = client.get("/search", headers={"Authorization": f"Bearer {forged}"})
    assert response.status_code == 401


def test_principal_reads_the_claims_verified_for_this_request() -> None:
    """`authenticate` stashes the verified claims; `principal` answers from
    them — who acted, verified — not from configuration (ADR 018)."""
    request = request_with(make_token())
    auth.authenticate(request)
    assert request.state.claims["sub"] == OWNER
    assert auth.principal(request) == (OWNER, True)


def test_principal_fails_closed_without_verified_claims() -> None:
    with pytest.raises(auth.AuthError, match="no verified identity"):
        auth.principal(request_with(None))


def test_principal_disabled_mode_is_explicitly_unverified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LIFEOS_AUTH_MODE", "disabled")
    assert auth.principal(request_with(None)) == (auth.LOCAL_DEV_PRINCIPAL, False)


@pytest.mark.parametrize("subject", [None, "", "not a principal; <script>", "-leading-dash"])
def test_principal_rejects_an_unbounded_subject(subject: Any) -> None:
    request = request_with(None)
    request.state.claims = {"sub": subject}
    with pytest.raises(auth.AuthError, match="usable principal"):
        auth.principal(request)
