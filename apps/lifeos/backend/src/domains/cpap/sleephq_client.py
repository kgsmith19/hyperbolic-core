"""SleepHQ public API v1 client (OAuth2 client-credentials).

Three calls, in order: `/oauth/token` (client-credentials grant) for a
bearer token, `/api/v1/me` for the operator's `current_team_id`, then
`/api/v1/teams/{team_id}/nights` for the pull window's nightly records
(JSON:API shape: `{"data": [{"id": ..., "attributes": {...}}, ...]}`).

Nothing here parses EDF, talks to myAir, or interprets a reading (roadmap
H2 pre-made decisions). Nothing here logs or returns a request/response body
verbatim: a provider error can echo request contents, and the request
carries a bearer token derived from a client secret (the bills/calendar
precedent — exception messages are class-name-only past this module).

The base URL is operator-configured (`LIFEOS_SLEEPHQ_BASE_URL`, defaulting to
the real SleepHQ host) rather than attacker-supplied, but `urlopen` follows
redirects across hosts by default, so a same-host redirect guard still
applies -- the calendar ingestion precedent, sized down for one trusted host
instead of arbitrary operator-supplied feed URLs.
"""

import json
import urllib.request
from datetime import date
from typing import Any
from urllib.parse import urlsplit

from kernel.http_fetch import SameHostRedirects as _BaseSameHostRedirects
from kernel.http_fetch import fetch_json_object

DEFAULT_BASE_URL = "https://sleephq.com"
TOKEN_PATH = "/oauth/token"
ME_PATH = "/api/v1/me"
NIGHTS_PATH = "/api/v1/teams/{team_id}/nights"

FETCH_TIMEOUT_S = 30
MAX_RESPONSE_BYTES = 1024 * 1024  # untrusted input bound


class SleepHQError(RuntimeError):
    """A SleepHQ API call failed. Raised with a static, secret-free message;
    callers print only the exception class name, never str(exc) built from
    provider text, because a provider error can echo request contents and the
    request carries a bearer token."""


class SleepHQAuthError(SleepHQError):
    """The token or team lookup failed -- credentials are present but wrong,
    or the account has no team. Distinct from a network-level SleepHQError so
    a caller could treat "wrong credentials" and "unreachable" differently,
    though today both simply fail the run."""


class _SameHostRedirects(_BaseSameHostRedirects):
    """Refuse any redirect that changes scheme family or leaves the
    configured API host, and cap the hops -- a compromised or misconfigured
    host must not be able to redirect a bearer-token-bearing request to an
    internal address."""

    def reject(self, hostname: str | None) -> Exception:
        return SleepHQError("refusing redirect off the configured SleepHQ host")


def _opener(base_url: str) -> urllib.request.OpenerDirector:
    host = urlsplit(base_url).hostname
    if not host:
        raise SleepHQError("LIFEOS_SLEEPHQ_BASE_URL is not a valid URL")
    return urllib.request.build_opener(_SameHostRedirects(host))


def _request_json(
    base_url: str, path: str, *, method: str, headers: dict[str, str], body: bytes | None
) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{base_url}{path}", data=body, method=method, headers=headers
    )
    try:
        return fetch_json_object(
            _opener(base_url),
            req,
            timeout=FETCH_TIMEOUT_S,
            max_bytes=MAX_RESPONSE_BYTES,
            oversize_error=SleepHQError("response exceeds size bound"),
            invalid_json_error=SleepHQError("response was not valid JSON"),
            not_object_error=SleepHQError("response was not a JSON object"),
        )
    except SleepHQError:
        raise
    except Exception as exc:
        raise SleepHQError(f"request failed: {type(exc).__name__}") from None


def fetch_access_token(client_id: str, client_secret: str, base_url: str) -> str:
    payload = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "scope": "read",
    }
    data = _request_json(
        base_url,
        TOKEN_PATH,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        body=json.dumps(payload).encode(),
    )
    token = data.get("access_token")
    if not isinstance(token, str) or not token:
        raise SleepHQAuthError("token response carried no access_token")
    return token


def _authed_get(base_url: str, path: str, token: str) -> dict[str, Any]:
    return _request_json(
        base_url,
        path,
        method="GET",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.api+json",
        },
        body=None,
    )


def fetch_team_id(token: str, base_url: str) -> str:
    data = _authed_get(base_url, ME_PATH, token)
    attributes = (data.get("data") or {}).get("attributes")
    team_id = attributes.get("current_team_id") if isinstance(attributes, dict) else None
    if team_id is None:
        raise SleepHQAuthError("/me response carried no current_team_id")
    return str(team_id)


def fetch_nights(
    token: str, base_url: str, team_id: str, window_start: date, window_end: date
) -> list[dict[str, Any]]:
    path = (
        f"{NIGHTS_PATH.format(team_id=team_id)}"
        f"?date_from={window_start.isoformat()}&date_to={window_end.isoformat()}"
    )
    data = _authed_get(base_url, path, token)
    items = data.get("data")
    return items if isinstance(items, list) else []
