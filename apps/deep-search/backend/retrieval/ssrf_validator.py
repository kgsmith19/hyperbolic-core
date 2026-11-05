"""Server-Side Request Forgery (SSRF) Protection & URL Validation.

Validates URLs prior to network egress, blocking loopback, private IP ranges,
cloud metadata endpoints, link-local, and non-HTTP protocols.
"""

import ipaddress
import socket
import urllib.parse


def is_safe_url(url: str, allow_local_searxng: bool = False, searxng_host: str = "localhost") -> bool:
    """Verify URL is safe and does not target internal services or SSRF addresses."""
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urllib.parse.urlparse(url.strip())
        if parsed.scheme not in ("http", "https"):
            return False
        hostname = parsed.hostname
        if not hostname:
            return False

        lower_host = hostname.lower()

        # Allow configured local SearXNG instance if explicitly requested
        if allow_local_searxng and (lower_host in (searxng_host.lower(), "localhost", "127.0.0.1")):
            return True

        if lower_host in ("localhost", "localhost.localdomain", "127.0.0.1", "::1") or lower_host.endswith(".local"):
            return False

        try:
            ip = ipaddress.ip_address(lower_host)
        except ValueError:
            try:
                resolved = socket.gethostbyname(lower_host)
                ip = ipaddress.ip_address(resolved)
            except Exception:
                return False

        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
        return True
    except Exception:
        return False
