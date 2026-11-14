"""Reviewed public portal routes, not payment APIs or authenticated connections.

Only public provider pages belong here. No user URLs, account query parameters,
credentials or network clients. Review dates concern published routing information,
not account access, balance, fees, payment availability or settlement. Re-review
routes after 90 days; an expired or future-dated review never yields a destination.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from types import MappingProxyType

REVIEW_LIFETIME = timedelta(days=90)


@dataclass(frozen=True, slots=True)
class PaymentPortal:
    url: str
    source_url: str
    verified_on: date


_REVIEWED_ON = date(2026, 11, 14)
_PORTALS = MappingProxyType({
    "hagerstown": PaymentPortal(
        "https://www.hagerstownmd.org/1580/Online-Payment-Portal",
        "https://www.hagerstownmd.org/1580/Online-Payment-Portal",
        _REVIEWED_ON,
    ),
    "firstenergy": PaymentPortal(
        "https://www.firstenergycorp.com/help/billingpayments/ways-to-pay/guest-payment.html",
        "https://www.firstenergycorp.com/help/billingpayments/ways-to-pay/guest-payment.html",
        _REVIEWED_ON,
    ),
    "antietam": PaymentPortal(
        "https://www.antietambroadband.com/billing",
        "https://www.antietambroadband.com/billing",
        _REVIEWED_ON,
    ),
})


def known_provider(provider: str) -> bool:
    return provider in _PORTALS


def reviewed_portal(provider: str, as_of: date) -> PaymentPortal | None:
    portal = _PORTALS.get(provider)
    if portal is None or not portal.verified_on <= as_of < portal.verified_on + REVIEW_LIFETIME:
        return None
    return portal
