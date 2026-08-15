"""Supabase Auth JWT verification -> AccessContext (ADR 008).

The API is the seam where identities become scoped contexts (invariant 5):
tokens are verified against the project's public JWKS (ES256), the subject
must be the allowlisted owner, and an optional ``scopes`` claim narrows the
context. Verification is local (cached public keys); no round-trip to
Supabase.

M4-20 adds a second, unrelated credential kind on this same door: the
self-issued ES256 agent token `mcp_server.tokens` already mints and verifies
for the stdio MCP transport. The Brain's `LifeOsSurface` client
(services/brain/src/lifeos-surface.ts) needs the HTTP surface (`/search`,
`/entities/*`, `/types`, `/action-proposals`) rather than an MCP subprocess,
and 05-e-lifeos.md section 3's own gate question 3 leaves that transport
choice open ("this plan's contract is transport-neutral and both are already
implemented server-side") — this file is that choice, made by extending
`authenticate()` rather than adding a parallel auth path. `read_scopes`
already refuses anything but `<domain>:read` or `action-proposals:draft`
(mcp_server/tokens.py), so an agent token can never reach `authenticate()`
with owner-level power.
"""

import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import jwt
from fastapi import Request

from kernel.access import AccessContext
from kernel.env import read_env
from mcp_server.tokens import AgentTokenError, decode_key
from mcp_server.tokens import verify as verify_agent_token

MODE_SUPABASE = "supabase"
MODE_DISABLED = "disabled"

_ALGORITHMS = ["ES256"]
_REQUIRED_CLAIMS = ["exp", "iat", "sub", "aud", "iss"]

# mcp_server.tokens.ISSUER, restated here rather than imported: importing it
# would pull in `mint`'s dependency on a private key this process never
# holds, for the sake of one string constant this module only ever reads.
_AGENT_TOKEN_ISSUER = "lifeos"


class AuthError(Exception):
    """Request is unauthenticated: missing, malformed, or rejected token."""


class AuthUnavailableError(Exception):
    """Authentication cannot run right now (e.g. the JWKS fetch failed)."""


@dataclass(frozen=True)
class AuthSettings:
    mode: str
    issuer: str
    jwks_url: str
    audience: str
    owner_user_id: str


def settings() -> AuthSettings:
    """Read auth settings from the environment. Fails closed: auth is on
    unless LIFEOS_AUTH_MODE=disabled is set explicitly (local dev only)."""
    mode = read_env("LIFEOS_AUTH_MODE") or MODE_SUPABASE
    if mode == MODE_DISABLED:
        return AuthSettings(mode=mode, issuer="", jwks_url="", audience="", owner_user_id="")
    if mode != MODE_SUPABASE:
        raise RuntimeError(
            f"LIFEOS_AUTH_MODE must be {MODE_SUPABASE!r} or {MODE_DISABLED!r}, got {mode!r}"
        )
    base = (read_env("LIFEOS_SUPABASE_URL") or "").rstrip("/")
    owner = read_env("LIFEOS_OWNER_USER_ID")
    if not base or not owner:
        raise RuntimeError(
            "auth is enabled but LIFEOS_SUPABASE_URL or LIFEOS_OWNER_USER_ID is unset; "
            f"set both, or LIFEOS_AUTH_MODE={MODE_DISABLED} for local development"
        )
    return AuthSettings(
        mode=mode,
        issuer=f"{base}/auth/v1",
        jwks_url=f"{base}/auth/v1/.well-known/jwks.json",
        audience=read_env("LIFEOS_AUTH_AUDIENCE") or "authenticated",
        owner_user_id=owner,
    )


@lru_cache(maxsize=4)
def _jwks_client(url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(url, cache_keys=True, lifespan=600)


def _looks_like_agent_token(token: str) -> bool:
    """Peek the (unverified) issuer claim to pick which verifier to run.

    This decides ROUTING only, never TRUST: whichever branch `authenticate`
    takes still fully verifies signature, expiry, audience and issuer itself
    against the real key for that credential kind. An owner JWT's issuer is
    always a Supabase project URL (`settings().issuer`, never the literal
    string below), so a forged `iss: "lifeos"` claim on a token signed by
    neither key is rejected the normal way: agent-token verification runs
    and fails the signature check.
    """
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError:
        return False
    return claims.get("iss") == _AGENT_TOKEN_ISSUER


def _authenticate_agent(request: Request, token: str) -> AccessContext:
    """M4-20's second credential kind on this door: a self-issued agent
    token in `mcp_server.tokens.mint`'s own format, verified with the exact
    function the stdio MCP transport already relies on — no new crypto
    logic, only a new place to call it from. Fails closed the same way a
    missing Supabase config already does: unconfigured means refused, not
    silently skipped."""
    public_key_b64 = read_env("LIFEOS_AGENT_JWT_PUBLIC_KEY")
    if not public_key_b64:
        raise AuthError("agent token presented but no agent signing key is configured")
    try:
        context = verify_agent_token(token, decode_key(public_key_b64))
        # Signature already proven valid above; this second, unverified
        # decode only reads `sub` back out for `principal()` (mint() always
        # sets it to `agent:<name>`, which `_SUBJECT` already accepts).
        unverified = jwt.decode(token, options={"verify_signature": False})
    except AgentTokenError as exc:
        raise AuthError(f"invalid agent token: {exc}") from exc
    request.state.claims = {"sub": unverified.get("sub")}
    return context


def authenticate(request: Request) -> AccessContext:
    conf = settings()
    if conf.mode == MODE_DISABLED:
        return AccessContext.all()
    header = request.headers.get("authorization")
    if header is None:
        raise AuthError("missing bearer token")
    scheme, _, token = header.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise AuthError("authorization header is not a bearer token")
    if _looks_like_agent_token(token):
        return _authenticate_agent(request, token)
    try:
        key = _jwks_client(conf.jwks_url).get_signing_key_from_jwt(token).key
    except jwt.PyJWKClientConnectionError as exc:
        raise AuthUnavailableError(f"could not fetch signing keys: {exc}") from exc
    except jwt.PyJWTError as exc:
        raise AuthError(f"invalid token: {exc}") from exc
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=_ALGORITHMS,
            audience=conf.audience,
            issuer=conf.issuer,
            options={"require": _REQUIRED_CLAIMS},
        )
    except jwt.PyJWTError as exc:
        raise AuthError(f"invalid token: {exc}") from exc
    if claims.get("sub") != conf.owner_user_id:
        raise AuthError("unknown subject")
    # Stashed for `principal()`: a route that must record WHO acted reads the
    # verified claims of this request rather than re-deriving an identity from
    # configuration, which is not the same thing (ADR 018).
    request.state.claims = claims
    return _context_from(claims)


# What an approval records when the box is running with auth off (local dev
# only). Not a fallback that pretends to be an owner: an authority receipt minted
# on an unauthenticated box says so, permanently and in the record itself.
LOCAL_DEV_PRINCIPAL = "local-dev-auth-disabled"

# A subject identifier is opaque, but it is written into a record, so it is
# bounded here rather than trusted for being signed.
_SUBJECT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$")


def principal(request: Request) -> tuple[str, bool]:
    """Who this request is, and whether that was verified.

    Read from the claims `authenticate` verified for **this request**, not from
    configuration. The first version returned `settings().owner_user_id`, which
    is the same string in the ordinary case and is not the same *claim*: it says
    who the owner is, never who acted. An authority receipt (ADR 018) is the
    system's only artifact distinguishing a human decision from an automated
    one, so it must not be built from an answer the request had no part in.

    Fails closed. With auth enabled, absent claims mean this was called outside
    the authenticated dependency and there is no subject to record; with auth
    disabled the returned identity is explicitly unverified and the caller is
    told so. The domain never imports this module — the route passes the result
    in.
    """
    conf = settings()
    claims = getattr(request.state, "claims", None)
    if not isinstance(claims, dict):
        if conf.mode == MODE_DISABLED:
            return LOCAL_DEV_PRINCIPAL, False
        raise AuthError("no verified identity on this request")
    subject = claims.get("sub")
    if not isinstance(subject, str) or not _SUBJECT.match(subject):
        raise AuthError("verified subject is not a usable principal identifier")
    return subject, True


def _context_from(claims: dict[str, Any]) -> AccessContext:
    """Narrow the context by the token's ``scopes`` claim, if it carries one.

    The unscoped owner context comes only from the *absence* of that claim —
    the owner's own session, which names no powers. A claim *value* asserting
    everything is refused: ``AccessContext.of("*")`` would be indistinguishable
    downstream from ``AccessContext.all()`` (the ADR 018 approval guard checks
    for exactly that member), so a wildcard-bearing scope would let a
    credential that names its own powers impersonate the session that names
    none. Real scopes are ``<domain>:<read|write>`` and never contain ``*``.
    """
    scopes = claims.get("scopes")
    if scopes is None:
        return AccessContext.all()
    if not isinstance(scopes, list) or not all(isinstance(s, str) for s in scopes):
        raise AuthError("malformed scopes claim")
    if any("*" in scope for scope in scopes):
        raise AuthError(
            "wildcard scopes are not grantable; the owner token carries no scopes claim"
        )
    return AccessContext.of(*scopes)
