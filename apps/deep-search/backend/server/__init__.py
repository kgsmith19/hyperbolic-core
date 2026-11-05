"""Server & Configuration Bounded Context.

Provides HTTP server for browser UI and REST endpoints,
along with environment variable loading and persistence.
"""

from backend.server.configuration import (
    load_env_file,
    save_env_file,
    load_lines,
)
from backend.server.web_server import (
    SafeResearchRequestHandler,
    ThreadedUIServer,
    start_ui_server,
)

__all__ = [
    "load_env_file",
    "save_env_file",
    "load_lines",
    "SafeResearchRequestHandler",
    "ThreadedUIServer",
    "start_ui_server",
]
