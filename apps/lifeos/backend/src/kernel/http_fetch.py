"""Same-host-redirect HTTP fetch helpers (issue #104).

Every domain that pulls from an external HTTP(S) API needs the same SSRF
guard -- ``urlopen`` follows redirects to anywhere by default, so a redirect
handler must refuse any hop that changes scheme family or leaves the
configured host, and cap the hop count -- plus a size-bounded response read
(untrusted input). That structural pattern was triplicated across
``domains.calendar.ingest``, ``domains.cpap.sleephq_client`` and
``domains.money.simplefin_client``. This module factors it out; each domain
still supplies its own auth headers and error classes/messages (OAuth bearer
vs Basic-auth-in-URL vs no-auth vary by domain, as do the byte caps), because
that is credential- and error-taxonomy-specific and belongs with the domain
that owns the credential.
"""

from __future__ import annotations

import json
import urllib.request
from typing import Any
from urllib.parse import urlsplit


class SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse any redirect that changes scheme family or leaves ``host``,
    and cap the hop count. Subclass and override :meth:`reject` to raise a
    domain-specific error instead of the default ``ValueError``."""

    max_redirections = 3

    def __init__(self, host: str) -> None:
        self._host = host

    def reject(self, hostname: str | None) -> Exception:
        return ValueError(f"refusing redirect off the configured host (to {hostname!r})")

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        parts = urlsplit(newurl)
        if parts.scheme not in ("http", "https") or parts.hostname != self._host:
            raise self.reject(parts.hostname)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_bounded(
    opener: urllib.request.OpenerDirector,
    req: urllib.request.Request | str,
    *,
    timeout: float,
    max_bytes: int,
    oversize_error: Exception,
) -> bytes:
    """Open ``req`` through ``opener`` and read at most ``max_bytes``,
    raising ``oversize_error`` if the body is larger."""
    with opener.open(req, timeout=timeout) as response:  # noqa: S310
        content: bytes = response.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise oversize_error
    return content


def fetch_json_object(
    opener: urllib.request.OpenerDirector,
    req: urllib.request.Request | str,
    *,
    timeout: float,
    max_bytes: int,
    oversize_error: Exception,
    invalid_json_error: Exception,
    not_object_error: Exception,
) -> dict[str, Any]:
    """``fetch_bounded`` plus JSON-object shape validation."""
    raw = fetch_bounded(
        opener, req, timeout=timeout, max_bytes=max_bytes, oversize_error=oversize_error
    )
    try:
        parsed = json.loads(raw)
    except ValueError:
        raise invalid_json_error from None
    if not isinstance(parsed, dict):
        raise not_object_error
    return parsed
