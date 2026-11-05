"""Token Blinding & Bidirectional Pseudonymization Engine.

Maps sensitive terms to synthetic semantic proxy tokens prior to external dispatch,
and rehydrates proxy tokens back to their original values locally within Secret Core.
"""

import re
from backend.privacy.watchlist_redactor import _build_term_pattern


def create_blinder(watchlist: list[str]) -> tuple[dict[str, str], dict[str, str]]:
    """Create bidirectional mapping between sensitive terms and semantic proxy tokens."""
    forward_map = {}
    reverse_map = {}
    for idx, item in enumerate(watchlist, start=1):
        clean = item.strip()
        if not clean:
            continue
        proxy = f"[TARGET_ENTITY_{idx}]"
        forward_map[clean] = proxy
        reverse_map[proxy] = clean
    return forward_map, reverse_map


def blind_text(text: str, forward_map: dict[str, str]) -> str:
    """Replace sensitive terms with their semantic proxy tokens."""
    if not text or not forward_map:
        return text if text else ""
    blinded = str(text)
    for term, proxy in forward_map.items():
        pattern = _build_term_pattern(term)
        if pattern:
            blinded = re.sub(pattern, proxy, blinded, flags=re.IGNORECASE)
    return blinded


def rehydrate_text(text: str, reverse_map: dict[str, str]) -> str:
    """Replace proxy tokens back with their original terms locally."""
    if not text or not reverse_map:
        return text if text else ""
    rehydrated = str(text)
    for proxy, original in reverse_map.items():
        rehydrated = rehydrated.replace(proxy, original)
    return rehydrated
