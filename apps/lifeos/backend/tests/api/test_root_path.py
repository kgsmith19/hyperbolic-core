"""Base-path mechanics for the one-origin route table (m2-08;
docs/planning/05-a-hyperbolic-core.md section 4; 10-cicd-deployment.md
section 4's "LifeOS API; FastAPI `root_path` handles the prefix" row).

`tailscale serve --set-path=/life/api/ http://127.0.0.1:8000`
(docs/ops/tailscale-serve-apply.sh) forwards the FULL incoming path to this
app — it does not strip `/life/api` itself — so these tests exercise the
actual property that matters: a request arriving with that prefix intact
still reaches the right route once `LIFEOS_ROOT_PATH` is set, and every
existing (unprefixed) call keeps working when it is not. `auth_disabled`
(tests/api/conftest.py) is autouse for this whole package, so these hit real
route handlers without needing a bearer token.
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from api import main as main_module
from api.main import app

client = TestClient(app)


@pytest.fixture
def root_path(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    value: str = request.param
    monkeypatch.setenv("LIFEOS_ROOT_PATH", value)
    # Env vars only, matching api.auth's own test fixture (test_auth.py's
    # `supabase_mode`) -- a developer's repo .env must not leak into this
    # process-wide env-var read.
    monkeypatch.setattr(main_module, "read_env", lambda name: __import__("os").environ.get(name))
    yield value


def test_unset_root_path_is_a_no_op_and_bare_paths_still_route() -> None:
    """LO-1: every deploy and every test before this issue never set
    LIFEOS_ROOT_PATH, so this is the default this suite must never break."""
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_prefixed_request_404s_without_root_path_configured() -> None:
    """RED case: the middleware never fabricates a match it wasn't told to
    make -- a request that actually arrived with the /life/api prefix intact
    404s if the operator forgot to set LIFEOS_ROOT_PATH, rather than silently
    routing on a guess."""
    response = client.get("/life/api/healthz")
    assert response.status_code == 404


@pytest.mark.parametrize("root_path", ["/life/api"], indirect=True)
def test_prefixed_request_routes_once_root_path_is_set(root_path: str) -> None:
    """GREEN case: the exact route table entry this issue wires
    (docs/ops/runbook.md: `/life/api/*` -> `http://127.0.0.1:8000`) -- the
    same path a real tailscale-serve-forwarded request carries reaches the
    same handler as the unprefixed call above."""
    response = client.get("/life/api/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize("root_path", ["/life/api"], indirect=True)
def test_root_path_is_reflected_in_scope_for_url_generation(root_path: str) -> None:
    """The stripped prefix is recorded on `scope["root_path"]`, not just
    discarded -- this is what keeps FastAPI's generated OpenAPI/docs URLs
    (and any `url_for` call) correct behind the proxy, per the FastAPI
    "proxy that does not strip the path" recipe this middleware follows."""
    response = client.get("/life/api/openapi.json")
    assert response.status_code == 200
    servers = response.json().get("servers")
    assert servers == [{"url": "/life/api"}]


@pytest.mark.parametrize("root_path", ["/life/api/"], indirect=True)
def test_trailing_slash_on_the_configured_prefix_is_tolerated(root_path: str) -> None:
    """docs/ops/runbook.md's route table writes the mount path with a
    trailing slash (`/life/api/`); the env var should not have to be typed
    without one to work."""
    response = client.get("/life/api/healthz")
    assert response.status_code == 200


@pytest.mark.parametrize("root_path", ["/life/api"], indirect=True)
def test_a_path_that_merely_shares_the_prefix_as_a_substring_is_not_stripped(
    root_path: str,
) -> None:
    """`/life/apiary` must not be mistaken for `/life/api/ary` -- the prefix
    match requires a `/` boundary (or exact equality), not a bare
    `str.startswith`."""
    response = client.get("/life/apiary")
    assert response.status_code == 404


@pytest.mark.parametrize("root_path", ["/life/api"], indirect=True)
def test_upload_size_cap_still_matches_the_prefixed_documents_path(root_path: str) -> None:
    """Ordering claim, exercised for real: `cap_upload_size`
    (api/main.py) checks `request.url.path == "/documents"` by exact string
    equality, so this only works behind the `/life/api` prefix if the root-
    path strip has ALREADY happened by the time that check runs --
    `_StripRootPathMiddleware` must be the outermost middleware, not merely
    documented as such. A declared Content-Length over the cap must still
    produce a 413 (not a pass-through 404/422) when the request carries the
    full `/life/api/documents` path a real tailscale-serve-forwarded upload
    would use."""
    from domains.documents.capture import MAX_UPLOAD_BYTES

    oversized = b"x" * (MAX_UPLOAD_BYTES + 1024)
    response = client.post(
        "/life/api/documents",
        files={"file": ("big.bin", oversized, "application/octet-stream")},
    )
    assert response.status_code == 413
