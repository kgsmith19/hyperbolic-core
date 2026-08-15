"""The one Anthropic client construction (ADR 011).

``api.chat``, ``domains.bills.extract`` and ``domains.intentions.
import_priorities`` each defined a byte-identical ``get_model_client``, and
each carried a docstring pointing at the others as the reason it was correct
-- three copies agreeing by comment rather than by construction. Same shape as
``kernel.http_fetch``: one structural rule every caller needs identically,
factored out, with anything genuinely per-caller (model name, prompt, error
taxonomy) left in the domain.

The rule itself: the SDK's own key resolution reads ONLY process env, so the
key must come through ``read_env`` to honour the repo secret convention (env
var or repo ``.env``). A caller constructing ``anthropic.Anthropic()`` bare
would silently work on a machine with the env var exported and fail on one
configured through ``.env`` alone.
"""

import anthropic

from kernel.env import read_env


def get_model_client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=read_env("ANTHROPIC_API_KEY"))
