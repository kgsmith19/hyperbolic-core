"""Security Guard Bounded Context.

Enforces zero-secret-egress, transport-level socket air-gap,
watchlist pseudonymization, k-anonymity decoy generation,
and volatile memory encryption with zeroization.
"""

from backend.privacy.socket_airgap import (
    enforce_secret_core_socket_block,
)
from backend.privacy.watchlist_redactor import (
    SafetyError,
    normalize_for_match,
    _build_term_pattern,
    redact,
    assert_safe_to_send,
)
from backend.privacy.token_blinder import (
    create_blinder,
    blind_text,
    rehydrate_text,
)
from backend.privacy.statistical_chaffer import (
    DOMAIN_VOCABULARY,
    DECOY_TOPICS,
    calculate_shannon_entropy,
    QueryProfile,
    StatisticalChaffer,
    generate_statistical_decoys,
    generate_chaffed_prompt,
    extract_chaffed_response,
)
from backend.privacy.encrypted_scratchpad import (
    SecureZeroBuffer,
    EphemeralEncryptedScratch,
)
from backend.privacy.quarantine_zone import (
    SanitizedQuarantine,
)

__all__ = [
    "enforce_secret_core_socket_block",
    "SafetyError",
    "normalize_for_match",
    "_build_term_pattern",
    "redact",
    "assert_safe_to_send",
    "create_blinder",
    "blind_text",
    "rehydrate_text",
    "DOMAIN_VOCABULARY",
    "DECOY_TOPICS",
    "calculate_shannon_entropy",
    "QueryProfile",
    "StatisticalChaffer",
    "generate_statistical_decoys",
    "generate_chaffed_prompt",
    "extract_chaffed_response",
    "SecureZeroBuffer",
    "EphemeralEncryptedScratch",
    "SanitizedQuarantine",
]
