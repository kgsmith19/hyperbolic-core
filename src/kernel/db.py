"""Database connection helper. DATABASE_URL from env, else the repo .env file."""

from typing import Any

import psycopg
from psycopg.rows import dict_row

from kernel.env import read_env

Connection = psycopg.Connection[dict[str, Any]]


def database_url() -> str:
    url = read_env("DATABASE_URL")
    if url:
        return url
    raise RuntimeError("DATABASE_URL is not set and no .env file was found")


def connect() -> Connection:
    return psycopg.connect(database_url(), row_factory=dict_row)
