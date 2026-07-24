"""Database connection helper. DATABASE_URL from env, else the repo .env file."""

import os
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

Connection = psycopg.Connection[dict[str, Any]]


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    env_file = Path(__file__).resolve().parents[2] / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("DATABASE_URL="):
                return stripped.split("=", 1)[1].strip()
    raise RuntimeError("DATABASE_URL is not set and no .env file was found")


def connect() -> Connection:
    return psycopg.connect(database_url(), row_factory=dict_row)
