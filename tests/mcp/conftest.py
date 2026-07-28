"""MCP-tier fixtures: an ephemeral ES256 keypair and a way to wire a minted
agent token into the environment, exactly as an MCP client would."""

import base64
from collections.abc import Callable

import pytest
from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, generate_private_key
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

from mcp_server.tokens import mint


def make_keypair() -> tuple[str, str]:
    key = generate_private_key(SECP256R1())
    private_pem = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()
    public_pem = (
        key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
    )
    return private_pem, public_pem


@pytest.fixture(scope="session")
def keypair() -> tuple[str, str]:
    return make_keypair()


@pytest.fixture(scope="session")
def other_keypair() -> tuple[str, str]:
    return make_keypair()


@pytest.fixture
def install_token(
    keypair: tuple[str, str], monkeypatch: pytest.MonkeyPatch
) -> Callable[..., str]:
    """Mint a token for the given scopes and put token + public key in env."""

    def _install(*scopes: str) -> str:
        private_pem, public_pem = keypair
        token = mint(private_pem, scopes, agent="tests", days=1)
        monkeypatch.setenv("LIFEOS_AGENT_TOKEN", token)
        monkeypatch.setenv(
            "LIFEOS_AGENT_JWT_PUBLIC_KEY", base64.b64encode(public_pem.encode()).decode()
        )
        return token

    return _install
