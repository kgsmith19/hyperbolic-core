"""Guard: air-gap, assert, or blind the topic before any network work."""

from backend.research.types import SearchOptions
from backend.privacy.socket_airgap import enforce_secret_core_socket_block
from backend.privacy.token_blinder import blind_text, create_blinder
from backend.privacy.watchlist_redactor import assert_safe_to_send


def prepare_topic(topic: str, watchlist: list[str], options: SearchOptions) -> str:
    """Return a safe or blinded topic. Reverse maps never leave this function."""
    allow_openai = bool(options.ai_planning or options.ai_summary)
    enforce_secret_core_socket_block(allow_openai=allow_openai)

    if options.blind_watchlist:
        forward_map, _reverse_map = create_blinder(watchlist)
        return blind_text(topic, forward_map)

    assert_safe_to_send(topic, watchlist)
    return topic
