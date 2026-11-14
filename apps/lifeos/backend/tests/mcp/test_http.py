"""Remote MCP transport: an OAuth resource server any harness can reach (agent ingress ADR).

Real tokens are minted and verified with the production functions; the Cloudflare Access edge
is exercised with a real RS256 key standing in for the team certs. The claims under test are
discovery (401 + RFC 9728 metadata), who may call, and that request_decision records exactly
what POST /agents/requests records: the verified requester, the role allowlist, nothing run.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from starlette.testclient import TestClient

from domains.agents.requests import requester_of
from kernel.access import AccessContext
from mcp_server.http import HttpSettings, build_app
from mcp_server.tokens import AGENTS_REQUEST_SCOPE, mint
from tests.mcp.conftest import make_keypair

RESOURCE = "https://core.example.com/life/mcp"
ISSUER = "https://auth.example.com"
BASE = "https://core.example.com"
HEADERS = {"accept": "application/json, text/event-stream"}
TEAM = "team.cloudflareaccess.com"
AUD = "aud-tag-123"
_RSA = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def settings(**edge: Any) -> HttpSettings:
    return HttpSettings(resource_url=RESOURCE, issuer_url=ISSUER, **edge)


@pytest.fixture
def agent_client(keypair: tuple[str, str]) -> Iterator[TestClient]:
    with TestClient(build_app(settings(), public_key=lambda: keypair[1]), base_url=BASE) as client:
        yield client


@pytest.fixture
def edge_client(keypair: tuple[str, str]) -> Iterator[TestClient]:
    app = build_app(
        settings(
            edge="cloudflare-access",
            edge_team_domain=TEAM,
            edge_aud=AUD,
            edge_scopes=(AGENTS_REQUEST_SCOPE,),
            edge_roles=("communications", "household_operations"),
        ),
        public_key=lambda: keypair[1],
        jwks=lambda token: _RSA.public_key(),
    )
    with TestClient(app, base_url=BASE) as client:
        yield client


def call(client: TestClient, method: str, params: dict[str, Any], **headers: str) -> Any:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    return client.post("/mcp", json=body, headers={**HEADERS, **headers})


def tool_result(response: Any) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert not result.get("isError"), result
    return json.loads(result["content"][0]["text"])


def access_jwt(aud: str = AUD, exp: int | None = None, iss: str = f"https://{TEAM}") -> str:
    now = int(time.time())
    claims = {"aud": aud, "iss": iss, "sub": "u-1", "email": "owner@example.com", "iat": now}
    claims["exp"] = exp if exp is not None else now + 300
    return jwt.encode(claims, _RSA, algorithm="RS256")


def test_unauthenticated_call_points_at_protected_resource_metadata(
    agent_client: TestClient,
) -> None:
    response = call(agent_client, "tools/list", {})
    assert response.status_code == 401
    challenge = response.headers["www-authenticate"]
    assert (
        'resource_metadata="https://core.example.com/.well-known/oauth-protected-resource/life/mcp"'
        in challenge
    )
    metadata = agent_client.get("/.well-known/oauth-protected-resource/life/mcp").json()
    assert metadata["resource"] == RESOURCE and metadata["authorization_servers"] == [ISSUER]


def test_a_forged_or_wrong_audience_token_is_refused(agent_client: TestClient) -> None:
    other_private, _ = make_keypair()
    forged = mint(
        other_private, [AGENTS_REQUEST_SCOPE], agent="chatgpt", days=1, roles=["communications"]
    )
    assert call(agent_client, "tools/list", {}, authorization=f"Bearer {forged}").status_code == 401


def test_agent_token_lists_tools_and_request_decision_records_the_verified_requester(
    agent_client: TestClient, keypair: tuple[str, str]
) -> None:
    token = mint(
        keypair[0], [AGENTS_REQUEST_SCOPE], agent="chatgpt", days=1, roles=["communications"]
    )
    auth = {"authorization": f"Bearer {token}"}
    names = {
        t["name"] for t in call(agent_client, "tools/list", {}, **auth).json()["result"]["tools"]
    }
    assert {"list_types", "find", "get_entity", "history", "request_decision"} <= names

    key = f"http-{uuid4()}"
    args = {"role": "communications", "permission": "create_drafts", "idempotency_key": key}
    body = tool_result(
        call(agent_client, "tools/call", {"name": "request_decision", "arguments": args}, **auth)
    )
    assert body["requested_by"] == "agent:chatgpt" and body["executed"] is False
    assert requester_of(AccessContext.of("agents:read"), body["receipt_key"]) == "agent:chatgpt"
    again = tool_result(
        call(agent_client, "tools/call", {"name": "request_decision", "arguments": args}, **auth)
    )
    assert again["duplicate"] is True and again["receipt_key"] == body["receipt_key"]


def test_a_role_outside_the_token_allowlist_is_refused(
    agent_client: TestClient, keypair: tuple[str, str]
) -> None:
    token = mint(
        keypair[0], [AGENTS_REQUEST_SCOPE], agent="chatgpt", days=1, roles=["communications"]
    )
    args = {
        "role": "financial_operations",
        "permission": "query_telemetry",
        "idempotency_key": f"x-{uuid4()}",
    }
    response = call(
        agent_client,
        "tools/call",
        {"name": "request_decision", "arguments": args},
        authorization=f"Bearer {token}",
    )
    assert response.status_code == 200 and response.json()["result"]["isError"] is True


def test_edge_identity_signs_in_through_the_proxy_and_gets_only_its_configured_roles(
    edge_client: TestClient,
) -> None:
    key = f"edge-{uuid4()}"
    args = {"role": "communications", "permission": "create_drafts", "idempotency_key": key}
    # No Authorization header at all: the edge stripped the client's opaque token.
    body = tool_result(
        call(
            edge_client,
            "tools/call",
            {"name": "request_decision", "arguments": args},
            **{"cf-access-jwt-assertion": access_jwt()},
        )
    )
    assert body["requested_by"] == "access:owner@example.com"
    outside = {
        "role": "financial_operations",
        "permission": "query_telemetry",
        "idempotency_key": f"o-{uuid4()}",
    }
    refused = call(
        edge_client,
        "tools/call",
        {"name": "request_decision", "arguments": outside},
        **{"cf-access-jwt-assertion": access_jwt()},
    )
    assert refused.json()["result"]["isError"] is True


@pytest.mark.parametrize(
    "assertion",
    [
        lambda: access_jwt(aud="another-app"),
        lambda: access_jwt(exp=int(time.time()) - 10),
        lambda: access_jwt(iss="https://evil.cloudflareaccess.com"),
        lambda: "not-a-jwt",
    ],
)
def test_edge_assertion_is_verified_never_trusted_for_being_present(
    edge_client: TestClient, assertion: Any
) -> None:
    response = call(edge_client, "tools/list", {}, **{"cf-access-jwt-assertion": assertion()})
    assert response.status_code == 401


def test_settings_require_resource_and_issuer() -> None:
    from mcp_server.tokens import AgentTokenError

    with pytest.raises(AgentTokenError):
        HttpSettings.from_env(lambda name: None)
    parsed = HttpSettings.from_env(
        lambda name: {
            "LIFEOS_MCP_RESOURCE_URL": RESOURCE,
            "LIFEOS_MCP_AUTH_ISSUER": ISSUER,
            "LIFEOS_MCP_EDGE": "cloudflare-access",
            "LIFEOS_MCP_EDGE_ROLES": "communications, household_operations",
        }.get(name)
    )
    assert parsed.edge_roles == ("communications", "household_operations")


def test_a_foreign_host_is_refused_by_the_dns_rebinding_guard(keypair: tuple[str, str]) -> None:
    token = mint(
        keypair[0], [AGENTS_REQUEST_SCOPE], agent="chatgpt", days=1, roles=["communications"]
    )
    with TestClient(
        build_app(settings(), public_key=lambda: keypair[1]), base_url="https://evil.example"
    ) as client:
        response = call(client, "tools/list", {}, authorization=f"Bearer {token}")
    assert response.status_code == 421
