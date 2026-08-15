"""Token verification: the API refuses everything but the owner's valid
ES256 Supabase JWT, and a scopes claim narrows the AccessContext."""

import base64
import os
import time
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)
from fastapi.testclient import TestClient
from starlette.requests import Request

from api import auth
from api.main import app
from kernel.access import ALL_SCOPES, has
from mcp_server.tokens import ACTION_PROPOSALS_DRAFT_SCOPE, mint

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


# --- m2-08: platform-issuer fixtures (LO-2c, LO-2d) --------------------------
#
# docs/planning/05-e-lifeos.md section 4 / ADR-03: the auth migration this
# issue performs is an ENV RE-POINT, not a code change -- `settings()` above
# already builds the issuer/JWKS URL and owner check from
# LIFEOS_SUPABASE_URL/LIFEOS_OWNER_USER_ID, whichever project those name.
# `supabase_mode` (this file's own autouse fixture) already configures those
# two vars to a stand-in "platform project" for every test in this module,
# which is exactly what a real re-point does in production.
#
# What was NOT already covered before this issue: a scenario that names both
# sides of the migration explicitly -- a token signed by the OLD (pre-
# migration) project's key, presented against settings already re-pointed at
# the NEW (platform) project -- rather than the single generic
# "_OTHER_KEY"/"_PUBLIC_KEY" pair every test above already exercises for the
# same underlying property. These fixtures exist to make that specific claim
# checkable by name, matching the issue's own EARS criteria (05-e section 4):
#
#   LO-2c: a JWT signed by the OLD project's keys is rejected with 401.
#   LO-2d: a platform JWT whose subject is not the owner UUID is rejected
#          with 401.
_OLD_PROJECT_URL = "https://vhbzblllaohuljtareza.supabase.co"  # pre-migration LifeOS project
_OLD_ISSUER = f"{_OLD_PROJECT_URL}/auth/v1"
_OLD_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())

_PLATFORM_OWNER = OWNER  # this module's `supabase_mode` fixture re-points to this owner


def _old_project_token(**overrides: Any) -> str:
    """A token that would have verified fine against the pre-migration
    LifeOS project: correct-shaped claims, signed with a DIFFERENT key under
    a DIFFERENT issuer than the platform project `supabase_mode` re-points
    `settings()` at."""
    now = int(time.time())
    claims: dict[str, Any] = {
        "sub": _PLATFORM_OWNER,
        "aud": "authenticated",
        "iss": _OLD_ISSUER,
        "iat": now,
        "exp": now + 300,
    }
    claims.update(overrides)
    return jwt.encode(
        claims, _OLD_PRIVATE_KEY, algorithm="ES256", headers={"kid": "old-project-key"}
    )


def test_lo2c_stale_issuer_token_from_the_old_project_is_rejected() -> None:
    """LO-2c. `supabase_mode` has already re-pointed `settings()` at the
    platform project (SUPABASE_URL/ISSUER at the top of this file); this
    token is signed by a project that migration retired. The JWKS client
    stub always hands back the PLATFORM project's public key (`_PUBLIC_KEY`)
    regardless of the token it's asked about, so this failure is the
    signature check catching a genuine cross-project mismatch, not a stub
    artifact -- the same failure mode as a real JWKS lookup against the
    platform project rejecting a signature it never produced."""
    with pytest.raises(auth.AuthError, match="invalid token"):
        auth.authenticate(request_with(_old_project_token()))


def test_lo2c_route_rejects_the_stale_issuer_token_with_401() -> None:
    """Route-level restatement of LO-2c, matching the issue's own
    verification command shape (`curl ... /life/api/types` -> 401) as
    closely as a TestClient call can from inside this process."""
    client = TestClient(app)
    response = client.get("/types", headers={"Authorization": f"Bearer {_old_project_token()}"})
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_lo2d_platform_token_with_the_wrong_subject_is_rejected() -> None:
    """LO-2d. Correctly signed by the PLATFORM project's own key (unlike the
    LO-2c case above), but the subject is not the owner UUID
    `LIFEOS_OWNER_USER_ID` re-points to -- a second principal, or a stray
    token minted for some other purpose, must not pass."""
    not_the_owner = "99999999-9999-9999-9999-999999999999"
    token = make_token(sub=not_the_owner)
    with pytest.raises(auth.AuthError, match="unknown subject"):
        auth.authenticate(request_with(token))


def test_lo2d_route_rejects_the_wrong_subject_token_with_401() -> None:
    not_the_owner = "99999999-9999-9999-9999-999999999999"
    client = TestClient(app)
    response = client.get(
        "/types", headers={"Authorization": f"Bearer {make_token(sub=not_the_owner)}"}
    )
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_lo2_valid_platform_owner_token_still_succeeds() -> None:
    """Contrast case: the migration narrows what is ACCEPTED (LO-2c/LO-2d),
    it must not also reject the one identity it exists to keep working."""
    client = TestClient(app)
    response = client.get("/types", headers={"Authorization": f"Bearer {make_token()}"})
    assert response.status_code == 200


# --- M4-20: agent tokens on the HTTP door -----------------------------------
#
# The Brain's LifeOsSurface client (services/brain/src/lifeos-surface.ts)
# calls this API over HTTP, not the stdio MCP transport, so `authenticate()`
# grew a second credential kind: the same self-issued ES256 agent token
# `mcp_server.tokens` already mints/verifies for the MCP door. These tests
# exercise that path directly against `auth.authenticate`/`auth.principal`;
# `mcp_server/tests/test_tokens.py` already covers `mint`/`verify` themselves
# (scope validation, expiry, wrong key), so these focus on what's new here:
# routing an agent token to the right verifier, wiring `LIFEOS_AGENT_JWT_
# PUBLIC_KEY`, and `principal()` reading the resulting `sub`.

_AGENT_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())
_AGENT_PUBLIC_PEM = (
    _AGENT_PRIVATE_KEY.public_key()
    .public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    .decode()
)
_AGENT_PRIVATE_PEM = _AGENT_PRIVATE_KEY.private_bytes(
    Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()
).decode()
_OTHER_AGENT_PRIVATE_PEM = (
    ec.generate_private_key(ec.SECP256R1())
    .private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    .decode()
)


def _agent_token(*scopes: str, private_pem: str = _AGENT_PRIVATE_PEM, agent: str = "brain") -> str:
    return mint(private_pem, scopes, agent=agent, days=1)


def test_agent_token_grants_exactly_its_own_scopes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "LIFEOS_AGENT_JWT_PUBLIC_KEY", base64.b64encode(_AGENT_PUBLIC_PEM.encode()).decode()
    )
    token = _agent_token("ops:read", ACTION_PROPOSALS_DRAFT_SCOPE)
    context = auth.authenticate(request_with(token))
    assert has(context, "ops:read")
    assert has(context, ACTION_PROPOSALS_DRAFT_SCOPE)
    assert not has(context, "bills:write")
    assert context.scopes != frozenset({ALL_SCOPES})


def test_agent_token_without_configured_public_key_fails_closed() -> None:
    """Unconfigured must refuse, not silently fall through to the owner
    path (an agent token would never verify as a Supabase JWT anyway, but
    the failure must name the real reason)."""
    token = _agent_token("ops:read")
    with pytest.raises(auth.AuthError, match="agent signing key"):
        auth.authenticate(request_with(token))


def test_agent_token_signed_by_the_wrong_key_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "LIFEOS_AGENT_JWT_PUBLIC_KEY", base64.b64encode(_AGENT_PUBLIC_PEM.encode()).decode()
    )
    forged = _agent_token("ops:read", private_pem=_OTHER_AGENT_PRIVATE_PEM)
    with pytest.raises(auth.AuthError, match="invalid agent token"):
        auth.authenticate(request_with(forged))


def test_agent_token_principal_reads_the_agent_subject(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "LIFEOS_AGENT_JWT_PUBLIC_KEY", base64.b64encode(_AGENT_PUBLIC_PEM.encode()).decode()
    )
    request = request_with(_agent_token(ACTION_PROPOSALS_DRAFT_SCOPE, agent="brain"))
    auth.authenticate(request)
    assert request.state.claims["sub"] == "agent:brain"
    assert auth.principal(request) == ("agent:brain", True)


def test_owner_supabase_token_still_authenticates_when_agent_key_is_also_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The two credential kinds coexist: configuring agent-token support
    must not disturb the owner JWT path this door has always served."""
    monkeypatch.setenv(
        "LIFEOS_AGENT_JWT_PUBLIC_KEY", base64.b64encode(_AGENT_PUBLIC_PEM.encode()).decode()
    )
    context = auth.authenticate(request_with(make_token()))
    assert context.scopes == frozenset({ALL_SCOPES})


def test_route_accepts_an_agent_token_over_http(monkeypatch: pytest.MonkeyPatch) -> None:
    """05-e-lifeos.md section 3 gate question 3, resolved: the Brain's read
    lane reaches this API over plain HTTP with an agent token, not only via
    the stdio MCP transport."""
    monkeypatch.setenv(
        "LIFEOS_AGENT_JWT_PUBLIC_KEY", base64.b64encode(_AGENT_PUBLIC_PEM.encode()).decode()
    )
    client = TestClient(app)
    token = _agent_token("ops:read")
    response = client.get("/types", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200


def test_route_rejects_a_forged_agent_token_with_401(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "LIFEOS_AGENT_JWT_PUBLIC_KEY", base64.b64encode(_AGENT_PUBLIC_PEM.encode()).decode()
    )
    client = TestClient(app)
    forged = _agent_token("ops:read", private_pem=_OTHER_AGENT_PRIVATE_PEM)
    response = client.get("/types", headers={"Authorization": f"Bearer {forged}"})
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
