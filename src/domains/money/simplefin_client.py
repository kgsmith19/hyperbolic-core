"""SimpleFIN Bridge client (https://www.simplefin.org/protocol.html).

One call: ``GET {access_url}/accounts?start-date=...&end-date=...&pending=1``
returns ``{"accounts": [{"id", "name", "currency", "org", "transactions":
[...]}, ...]}``.

**The access URL is itself a bearer credential.** Unlike SleepHQ's
client_id/secret pair, SimpleFIN Bridge embeds HTTP Basic Auth
``username:password`` directly in the URL
(``https://user:pass@bridge.simplefin.org/simplefin``). This module parses
that URL exactly once, at ``_parse_access_url``, turns the userinfo into an
``Authorization: Basic`` header, and never again constructs or logs a string
containing the full URL, the username, or the password — only the host
(``urlsplit(...).hostname``) is ever safe to mention. Every downstream error
path is exception-class-name-only (the SleepHQ precedent): a provider error
can echo request contents, and the request carries the credential in its
headers.

The host is operator-configured (embedded in their own access URL) rather
than attacker-supplied, but `urlopen` follows redirects across hosts by
default, so a same-host redirect guard still applies — the SleepHQ/calendar
precedent, sized down for one operator-trusted host.
"""

import base64
import json
import urllib.request
from datetime import UTC, date, datetime, time
from typing import Any
from urllib.parse import urlsplit

FETCH_TIMEOUT_S = 30
MAX_RESPONSE_BYTES = 4 * 1024 * 1024  # untrusted input bound


class SimpleFinError(RuntimeError):
    """A SimpleFIN Bridge call failed. Raised with a static, secret-free
    message; callers print only the exception class name, never str(exc)
    built from provider text, because a provider error can echo request
    contents and the request carries a bearer credential."""


class SimpleFinAuthError(SimpleFinError):
    """The access URL is malformed, carries no credential, or the provider
    rejected it. Distinct from a network-level SimpleFinError so a caller
    could treat "wrong credential" and "unreachable" differently, though
    today both simply fail the run."""


class _SameHostRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse any redirect that changes scheme family or leaves the
    configured host, and cap the hops -- a compromised or misconfigured
    bridge host must not be able to redirect a credentialed request to an
    internal address."""

    max_redirections = 3

    def __init__(self, host: str) -> None:
        self._host = host

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
            raise SimpleFinError("refusing redirect off the configured SimpleFIN host")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _parse_access_url(access_url: str) -> tuple[str, str, str]:
    """(base_url, host, basic_auth_header) — extracted once, never returned
    or logged as the original URL again."""
    parts = urlsplit(access_url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SimpleFinAuthError("access URL is not a valid http(s) URL")
    if not parts.username or not parts.password:
        raise SimpleFinAuthError("access URL carries no embedded credential")
    port = f":{parts.port}" if parts.port else ""
    base = f"{parts.scheme}://{parts.hostname}{port}{parts.path.rstrip('/')}"
    token = base64.b64encode(f"{parts.username}:{parts.password}".encode()).decode()
    return base, parts.hostname, f"Basic {token}"


def fetch_accounts(
    access_url: str, start_date: date, end_date: date
) -> list[dict[str, Any]]:
    """One SimpleFIN `/accounts` pull for the given window (inclusive),
    including each account's `transactions` list. Never returns or raises
    anything containing `access_url` itself."""
    base, host, auth_header = _parse_access_url(access_url)
    start_ts = int(datetime.combine(start_date, time.min, tzinfo=UTC).timestamp())
    end_ts = int(datetime.combine(end_date, time.max, tzinfo=UTC).timestamp())
    path = f"/accounts?start-date={start_ts}&end-date={end_ts}&pending=1"

    req = urllib.request.Request(
        f"{base}{path}",
        method="GET",
        headers={"Authorization": auth_header, "Accept": "application/json"},
    )
    opener = urllib.request.build_opener(_SameHostRedirects(host))
    try:
        with opener.open(req, timeout=FETCH_TIMEOUT_S) as response:  # noqa: S310
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except SimpleFinError:
        raise
    except Exception as exc:
        raise SimpleFinError(f"request failed: {type(exc).__name__}") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise SimpleFinError("response exceeds size bound")
    try:
        parsed = json.loads(raw)
    except ValueError:
        raise SimpleFinError("response was not valid JSON") from None
    if not isinstance(parsed, dict):
        raise SimpleFinError("response was not a JSON object")

    errors = parsed.get("errors")
    accounts = parsed.get("accounts")
    if not isinstance(accounts, list):
        detail = "errors present" if errors else "no accounts field"
        raise SimpleFinAuthError(f"response carried no accounts list ({detail})")
    return accounts
