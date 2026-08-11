"""EP1 acceptance: no notification path exists in code for episodes.

Structural proof over the import graph, not prose, in three parts:

1. the episodes package imports no transport, scheduling or model module —
   nothing in the cell can send, push, or wake anything;
2. the episodes package contains no ``__main__`` entry point — every scheduled
   job in this repo is a ``python -m domains...`` module, and none lives here;
3. every module outside the cell that imports the domain is one of the
   declared pull/display surfaces: the capture-door dispatch (api.main), the
   owner-pulled chat reply (api.chat), and the assembled display-only briefing
   (domains.ops.briefing). No job, webhook or outbound sender consumes
   episode data.

The cell constitution's "pull-only — no notification path may exist in code"
is thereby a checked property: a future import of episodes from anywhere new
fails this test and must argue its way past the constitution first.
"""

import ast
from collections.abc import Iterator
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "src"
EPISODES = SRC / "domains" / "episodes"

# Transport, scheduling, process control, and the model SDK: none of these may
# appear in the episodes package (the domain is x-sensitive and pull-only).
FORBIDDEN = (
    "smtplib",
    "email",
    "http",
    "httpx",
    "requests",
    "urllib",
    "socket",
    "ssl",
    "websockets",
    "sched",
    "schedule",
    "apscheduler",
    "asyncio",
    "threading",
    "subprocess",
    "webbrowser",
    "anthropic",
)

# The only modules outside the cell allowed to touch the domain, each a
# pull/display surface (see the module docstring).
ALLOWED_CONSUMERS = {
    ("api", "chat.py"),
    ("api", "main.py"),
    ("domains", "ops", "briefing.py"),
}


def _imports(path: Path) -> Iterator[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            yield node.module


def _is(module: str, banned: str) -> bool:
    return module == banned or module.startswith(banned + ".")


def test_episodes_package_imports_no_transport_or_scheduler() -> None:
    for file in EPISODES.glob("*.py"):
        for module in _imports(file):
            hit = [banned for banned in FORBIDDEN if _is(module, banned)]
            assert not hit, f"{file.name} imports {module}"


def test_episodes_package_has_no_scheduled_entry_point() -> None:
    for file in EPISODES.glob("*.py"):
        assert "__main__" not in file.read_text(encoding="utf-8"), file.name


def test_only_declared_pull_surfaces_consume_the_domain() -> None:
    consumers = set()
    for file in SRC.rglob("*.py"):
        if EPISODES in file.parents:
            continue
        if any(_is(module, "domains.episodes") for module in _imports(file)):
            consumers.add(file.relative_to(SRC).parts)
    assert consumers == ALLOWED_CONSUMERS
