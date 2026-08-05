"""TTL cache for expensive or network-bound checks.

Several diagnostic modules hit the same external endpoint independently
(nat_diagnostics and cgnat_diagnostics both resolve the WAN IP via
api.ipify.org). Without a shared cache, `netcheck full-check` repeats that
round trip once per module that needs it. A short TTL is enough: the value
does not change within a single diagnostic run, but should not go stale
across separate `watch` ticks.
"""
import time
from functools import wraps

DEFAULT_TTL_S = 30.0


def ttl_cache(seconds=DEFAULT_TTL_S):
    """Cache a callable's return value (including None) for `seconds`.

    Keyed on the call's args/kwargs, so different inputs cache separately.
    `wrapper.cache_clear()` empties the cache, mainly for tests.
    """
    def decorator(fn):
        store = {}

        @wraps(fn)
        def wrapper(*args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            now = time.monotonic()
            cached = store.get(key)
            if cached is not None and now < cached[1]:
                return cached[0]
            value = fn(*args, **kwargs)
            store[key] = (value, now + seconds)
            return value

        wrapper.cache_clear = store.clear
        return wrapper
    return decorator
