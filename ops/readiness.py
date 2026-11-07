#!/usr/bin/env python3
"""Write a truthful, local-only readiness report for Hyperbolic Core."""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable

from local_stack import COMPONENTS, LocalComponent

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "var" / "local-readiness.md"


@dataclass(frozen=True)
class ComposeObservation:
    services: dict[str, str]
    unavailable_reason: str | None = None


def compose_status(run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run) -> ComposeObservation:
    """Return Compose health while preserving an actionable unavailable reason."""
    try:
        result = run(
            ["docker", "compose", "ps", "--format", "json"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError:
        return ComposeObservation({}, "Docker is not installed or is not on PATH")
    if result.returncode:
        detail = (result.stderr or result.stdout or "Docker Compose did not respond").strip().splitlines()[0]
        return ComposeObservation({}, detail)
    try:
        rows = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        return ComposeObservation({}, "Docker Compose returned invalid status data")
    if isinstance(rows, dict):
        rows = [rows]
    return ComposeObservation({
        row["Service"]: row.get("Health") or row.get("State") or "unknown"
        for row in rows
        if isinstance(row, dict) and isinstance(row.get("Service"), str)
    })


def row(component: LocalComponent, observation: ComposeObservation) -> tuple[str, str, str]:
    if component.kind == "compose":
        health = observation.services.get(component.name)
        if health in {"healthy", "running"}:
            return "running", f"docker compose reports `{health}`", "open the local access URL"
        if observation.unavailable_reason:
            return "prerequisite blocked", observation.unavailable_reason, "install or start Docker, then run `make up`"
        return "not running", "no healthy Compose service reported", "run `make up`, then `make readiness`"
    if component.kind == "external-dependency":
        return "external dependency", component.exclusion_reason or "not in root stack", "keep deferred during local-first activation"
    if component.kind == "tests-only":
        return "tests only", component.exclusion_reason or "no server", f"run `{component.command}`"
    return "separate local path", component.exclusion_reason or "not in root stack", f"follow `{component.command}`"


def render(observation: ComposeObservation, generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now(UTC)
    lines = [
        "# Hyperbolic Core local readiness",
        "",
        f"Generated: {generated_at.isoformat()}",
        "",
        "This report is local-only. It never reads credentials and it does not contact a hosted service.",
        "",
        "| Component | Local access | State | Evidence | Next smallest action |",
        "| --- | --- | --- | --- | --- |",
    ]
    for component in COMPONENTS:
        state, evidence, next_action = row(component, observation)
        lines.append(
            f"| `{component.name}` | {component.access} | {state} | {evidence} | {next_action} |"
        )
    lines.extend(
        [
            "",
            "## Commands",
            "",
            "- `npm ci` — install JavaScript dependencies once after cloning.",
            "- `make up` — generate local-only configuration and start root Compose services.",
            "- `make test` — run the cloud-free root verification suite.",
            "- `make telemetry` — query health for running root services.",
            "- `make readiness` — regenerate this report without changing runtime state.",
            "- `make down` — stop root Compose services.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    report = render(compose_status())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report)
    print(f"wrote {args.output.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
