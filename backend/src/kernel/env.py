"""Environment lookup with repo .env fallback. Shared by db and api auth."""

import os
from pathlib import Path


def read_env(name: str) -> str | None:
    value = os.environ.get(name)
    if value:
        return value
    env_file = Path(__file__).resolve().parents[2] / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            stripped = line.strip()
            if stripped.startswith(f"{name}="):
                return stripped.split("=", 1)[1].strip()
    return None
