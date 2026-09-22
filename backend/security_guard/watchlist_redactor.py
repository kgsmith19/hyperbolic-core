"""Watchlist Redaction, Matching Normalization & Safety Assertion.

Detects sensitive terms across multiple encoding variations (whitespace,
URL encoding, casing, separators) and redacts or blocks outbound egress.
"""

import re
import urllib.parse


class SafetyError(Exception):
    """Raised when a sensitive watchlist item or variation is detected."""
    pass


def normalize_for_match(value: str) -> str:
    """Normalize text by URL-decoding, lowercasing, and stripping whitespace, hyphens, and underscores."""
    if not value:
        return ""
    text = str(value)
    for _ in range(3):
        decoded = urllib.parse.unquote_plus(text)
        if decoded == text:
            break
        text = decoded
    return re.sub(r"[\s\-_+]+", "", text).lower()


def _build_term_pattern(term: str) -> str:
    """Build a regex pattern to match a term and its separator/encoding variations."""
    unquoted = urllib.parse.unquote_plus(term)
    core_chars = [char for char in unquoted if char not in " -_\t\r\n+"]
    if not core_chars:
        return ""
    char_patterns = [f"(?:{re.escape(c)}|%{ord(c):02x}|%{ord(c):02X})" for c in core_chars]
    separator_pattern = r"(?:[\s\-_+]|%20|%2d|%2D|%5f|%5F|%2b|%2B)*"
    return separator_pattern.join(char_patterns)


def redact(text: str, watchlist: list[str]) -> str:
    """Replace all case-insensitive and structural variants of watchlist items with a standard redaction marker."""
    if not text or not watchlist:
        return text if text else ""
    redacted_text = str(text)
    for item in watchlist:
        clean_item = item.strip()
        if not clean_item:
            continue
        pattern = _build_term_pattern(clean_item)
        if pattern:
            redacted_text = re.sub(pattern, "[REDACTED:local-watchlist-match]", redacted_text, flags=re.IGNORECASE)
    return redacted_text


def assert_safe_to_send(value, watchlist: list[str]) -> None:
    """Scan payload and raise SafetyError if any watchlist value or normalized variant is detected."""
    if value is None or not watchlist:
        return
    if isinstance(value, (list, tuple, set)):
        for item in value:
            assert_safe_to_send(item, watchlist)
        return
    if isinstance(value, dict):
        for k, v in value.items():
            assert_safe_to_send(k, watchlist)
            assert_safe_to_send(v, watchlist)
        return

    text = str(value)
    if redact(text, watchlist) != text:
        raise SafetyError("blocked by local safety guard")

    text_without_markers = text.replace("[REDACTED:local-watchlist-match]", " ")
    normalized_text = normalize_for_match(text_without_markers)
    for item in watchlist:
        item_norm = normalize_for_match(item.strip())
        if item_norm and item_norm in normalized_text:
            raise SafetyError("blocked by local safety guard")
