"""Coarse (city/region/country) geolocation for the current WAN address
(FR-020, EXT-006), via the free `ipapi.co` HTTPS API.

Split out of remote.py for the same reason docsis.py is: it keeps remote.py
under its length budget (AGENTS.md) as EXT-006 grows, and remote.wan() needs
to call locate() directly rather than the other way around -- the reverse of
how ssdp.py/snmp.py reach into remote.py. That direction means this module
must NOT import remote.py: remote.py already imports this module, and a
module remote.py imports cannot also import remote.py back without making a
real circular import, unlike ssdp.py/snmp.py, which remote.py never imports.
So locate() fetches with its own minimal urllib call instead of reusing
remote._http_get.

Geolocation is enrichment attached to the WAN section, never a diagnostic
signal on its own: FR-020 requires every failure mode here -- unreachable
API, timeout, malformed JSON, or a response carrying no location fields --
to degrade to `unavailable`, never `fail`. That is the opposite default from
remote._json_get, which reads a network error as `fail` because reachability
of that API *is* the signal for wan()/anthropic(). Do not reuse that
fail-on-network-error behavior here.
"""
import json
import urllib.request

URL_TEMPLATE = "https://ipapi.co/{ip}/json/"


def _unavailable(reason):
    return {"state": "unavailable", "reason": reason}


def _http_get(url, timeout=6):
    """GET a URL; return (body, error), exactly one not None.

    A private near-duplicate of remote._http_get, not a reuse of it -- see
    the module docstring for why this module cannot import remote.py.
    """
    req = urllib.request.Request(url, headers={"User-Agent": "netcheck"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace"), None
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def locate(ip, url_template=URL_TEMPLATE, timeout=6):
    """Coarse city/region/country for `ip`.

    Never `fail`: any way this can go wrong -- the API did not answer, or it
    answered with something that is not JSON, or JSON with no location in it
    -- reads `unavailable` alone, so a flaky geolocation provider can never
    read as a WAN problem.
    """
    url = url_template.format(ip=ip)
    body, err = _http_get(url, timeout)
    if err:
        return _unavailable(err)
    try:
        data = json.loads(body)
    except ValueError:
        return _unavailable(f"unparseable response from {url}")

    city, region = data.get("city"), data.get("region")
    country = data.get("country_name") or data.get("country")
    if not any((city, region, country)):
        return _unavailable("no location in response")
    return {"state": "ok", "city": city, "region": region, "country": country}
