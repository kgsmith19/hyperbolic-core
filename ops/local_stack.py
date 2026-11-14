"""The local-only stack's application inventory.

Both the compose contract tests and the operator-facing readiness report use
this module so an app cannot silently fall out of one view of the platform.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LocalComponent:
    path: str
    name: str
    kind: str
    access: str
    command: str
    exclusion_reason: str | None = None


COMPONENTS = (
    LocalComponent("services/platform-api", "platform-api", "compose", "http://platform.localhost:8400", "make up"),
    LocalComponent("services/broker", "broker", "compose", "http://127.0.0.1:8300/healthz", "make up"),
    LocalComponent("services/brain", "brain", "compose", "http://127.0.0.1:8100/healthz", "make up"),
    LocalComponent(
        "apps/network-checker", "network-checker", "compose", "http://127.0.0.1:8787", "make up"
    ),
    LocalComponent("apps/lifeos", "lifeos", "compose", "http://127.0.0.1:8000/healthz", "make up"),
    # The remote MCP door (#633): same image as lifeos, its own service and port.
    LocalComponent(
        "apps/lifeos/backend/src/mcp_server", "lifeos-mcp", "compose", "http://127.0.0.1:8090/mcp", "make up"
    ),
    LocalComponent(
        "services/llm-handler",
        "llm-handler",
        "external-dependency",
        "none",
        "not started by the root stack",
        "requires retired Supabase and GitHub-intake configuration at startup",
    ),
    LocalComponent(
        "apps/idea-intake", "idea-intake", "manual", "see apps/idea-intake/AGENTS.md", "read nested AGENTS.md first",
        "browser front end with no root compose service",
    ),
    LocalComponent(
        "apps/prompt-organizer", "prompt-organizer", "manual", "see apps/prompt-organizer/AGENTS.md", "read nested AGENTS.md first",
        "browser front end with no root compose service",
    ),
    LocalComponent(
        "apps/shell", "shell", "manual", "see apps/shell/AGENTS.md", "read nested AGENTS.md first",
        "browser front end with no root compose service",
    ),
    LocalComponent(
        "apps/agentic-command-center",
        "agentic-command-center",
        "manual",
        "see apps/agentic-command-center/AGENTS.md",
        "read nested AGENTS.md first",
        "browser front end or CLI with no root compose service",
    ),
    LocalComponent(
        "apps/deep-search", "deep-search", "standalone", "its own UI server", "read apps/deep-search/AGENTS.md first",
        "its SearXNG-backed compose stack is not yet wired into the root stack",
    ),
    LocalComponent(
        "apps/creative-studio", "creative-studio", "tests-only", "none", "python3 apps/creative-studio/scripts/validate.py",
        "documentation and registry validator; no server",
    ),
)


def composed_components() -> tuple[LocalComponent, ...]:
    return tuple(component for component in COMPONENTS if component.kind == "compose")


def excluded_components() -> tuple[LocalComponent, ...]:
    return tuple(component for component in COMPONENTS if component.kind != "compose")
