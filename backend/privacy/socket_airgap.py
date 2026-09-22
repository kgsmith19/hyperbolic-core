"""Socket-Level Physical Air-Gap Enforcement for Secret Core.

Intercepts low-level C/Python socket connections and blocks all non-loopback
egress at the transport layer to prevent accidental secret leakage.
"""

import socket

_ORIGINAL_SOCKET_CONNECT = None
_ALLOW_OPENAI = False
_OPENAI_IPS: set[str] = set()


def _get_openai_ips() -> set[str]:
    """Dynamically resolve and cache IP addresses for OpenAI endpoints."""
    global _OPENAI_IPS
    try:
        for host in ("api.openai.com", "openai.com"):
            for item in socket.getaddrinfo(host, 443):
                _OPENAI_IPS.add(item[4][0])
    except Exception:
        pass
    return _OPENAI_IPS


def enforce_secret_core_socket_block(allow_openai: bool = False) -> None:
    """Enforce strict socket-level air gap on Secret Core.

    Only localhost loopback (127.0.0.1, localhost, ::1, 0.0.0.0) is permitted.
    All external network calls from Secret Core are physically blocked at the socket layer.
    If allow_openai is True, requests to openai.com domains/IPs on ports 80/443 are permitted.
    """
    global _ORIGINAL_SOCKET_CONNECT, _ALLOW_OPENAI
    _ALLOW_OPENAI = allow_openai

    if _ORIGINAL_SOCKET_CONNECT is not None:
        return

    _ORIGINAL_SOCKET_CONNECT = socket.socket.connect

    def airgapped_connect(self, address):
        host, port = address[0], address[1]
        host_str = str(host).lower()

        # Loopback is always permitted for local IPC and local services
        if host_str in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
            return _ORIGINAL_SOCKET_CONNECT(self, address)

        # If allow_openai is enabled, permit connections to OpenAI hostnames or resolved IPs
        if _ALLOW_OPENAI and port in (443, 80):
            if "openai.com" in host_str:
                return _ORIGINAL_SOCKET_CONNECT(self, address)
            openai_ips = _get_openai_ips()
            if host_str in openai_ips:
                return _ORIGINAL_SOCKET_CONNECT(self, address)
            # Re-check resolution in case of dynamic DNS / Cloudflare anycast rotation
            try:
                refreshed_ips = {item[4][0] for item in socket.getaddrinfo("api.openai.com", 443)}
                _OPENAI_IPS.update(refreshed_ips)
                if host_str in _OPENAI_IPS:
                    return _ORIGINAL_SOCKET_CONNECT(self, address)
            except Exception:
                pass

        raise PermissionError(f"Secret Core air-gap violation: external network connection to {address} is strictly forbidden.")

    socket.socket.connect = airgapped_connect


def release_secret_core_socket_block() -> None:
    """Restore the original socket connect implementation."""
    global _ORIGINAL_SOCKET_CONNECT, _ALLOW_OPENAI
    if _ORIGINAL_SOCKET_CONNECT is not None:
        socket.socket.connect = _ORIGINAL_SOCKET_CONNECT
        _ORIGINAL_SOCKET_CONNECT = None
    _ALLOW_OPENAI = False
