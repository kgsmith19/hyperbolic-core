"""Register every built-in domain's types at startup (#562).

Each domain owns an idempotent `define_*_types`, but until now they ran only
lazily, from the ingest job or one-time script that first needed them. A fresh
install (the hyperbolic-core cloud host, a new local stack) therefore failed on
pages that read a type nothing had defined yet: Today showed "unknown type:
intention". Defining them once on boot keeps that lazy path working and makes
every page usable from the first request. Nothing is redefined: `define_missing`
only adds types that are absent.

Episodes are deliberately absent here: that cell is pull-only and may be
imported only by its declared surfaces (tests/episodes/test_no_notification_path.py),
so api.main, one of those surfaces, defines its types itself.
"""

from domains.agents.types import define_agent_types
from domains.bills.types import define_bills_types
from domains.calendar.types import define_calendar_types
from domains.cpap.types import define_cpap_types
from domains.health_connect.types import define_health_connect_types
from domains.intentions.types import define_intention_types
from domains.money.types import define_money_types
from domains.ops.types import define_ops_types
from kernel.access import AccessContext

DEFINERS = (
    define_agent_types,
    define_bills_types,
    define_calendar_types,
    define_cpap_types,
    define_health_connect_types,
    define_intention_types,
    define_money_types,
    define_ops_types,
)


def define_builtin_types() -> list[str]:
    """Define every built-in type that is missing; returns the names defined."""
    ctx = AccessContext.all()
    defined: list[str] = []
    for define in DEFINERS:
        defined.extend(define(ctx))
    return defined
