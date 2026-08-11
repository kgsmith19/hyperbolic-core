"""Route tests run with auth disabled so they exercise the passthrough end
to end; token verification itself is covered in test_auth.py."""

import os
from collections.abc import Iterator

import pytest


@pytest.fixture(scope="session", autouse=True)
def auth_disabled() -> Iterator[None]:
    previous = os.environ.get("LIFEOS_AUTH_MODE")
    os.environ["LIFEOS_AUTH_MODE"] = "disabled"
    yield
    if previous is None:
        del os.environ["LIFEOS_AUTH_MODE"]
    else:
        os.environ["LIFEOS_AUTH_MODE"] = previous
