"""Unit: the operator scripts behind the guards one-click setup — env-file
upsert and Claude Desktop registration are idempotent and preserving."""

import json
from pathlib import Path

from scripts.mint_agent_token import upsert_env
from scripts.setup_claude_desktop import VENV_PYTHON, register


def test_upsert_env_appends_then_replaces(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("DATABASE_URL=x\n", encoding="utf-8")
    upsert_env(env, "LIFEOS_AGENT_TOKEN", "t1")
    assert env.read_text(encoding="utf-8") == "DATABASE_URL=x\nLIFEOS_AGENT_TOKEN=t1\n"
    upsert_env(env, "LIFEOS_AGENT_TOKEN", "t2")
    assert env.read_text(encoding="utf-8") == "DATABASE_URL=x\nLIFEOS_AGENT_TOKEN=t2\n"


def test_upsert_env_creates_missing_file(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    upsert_env(env, "LIFEOS_AGENT_TOKEN", "t1")
    assert env.read_text(encoding="utf-8") == "LIFEOS_AGENT_TOKEN=t1\n"


def test_register_creates_config(tmp_path: Path) -> None:
    path = tmp_path / "Claude" / "claude_desktop_config.json"
    register(path)
    config = json.loads(path.read_text(encoding="utf-8"))
    assert config["mcpServers"]["lifeos"] == {
        "command": str(VENV_PYTHON),
        "args": ["-m", "mcp_server"],
    }


def test_register_preserves_other_servers_and_env_block(tmp_path: Path) -> None:
    path = tmp_path / "claude_desktop_config.json"
    path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "other": {"command": "x"},
                    "lifeos": {"command": "stale", "env": {"DATABASE_URL": "prod"}},
                }
            }
        ),
        encoding="utf-8",
    )
    register(path)
    config = json.loads(path.read_text(encoding="utf-8"))
    assert config["mcpServers"]["other"] == {"command": "x"}
    assert config["mcpServers"]["lifeos"]["command"] == str(VENV_PYTHON)
    assert config["mcpServers"]["lifeos"]["args"] == ["-m", "mcp_server"]
    assert config["mcpServers"]["lifeos"]["env"] == {"DATABASE_URL": "prod"}
