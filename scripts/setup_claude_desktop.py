"""Register the lifeos MCP server in Claude Desktop's config (ADR 010).

Usage: `python scripts/setup_claude_desktop.py`. Idempotent merge: asserts
command/args on the `lifeos` entry and preserves everything else, including
a custom `env` block (e.g. a prod DATABASE_URL). The entry holds no secrets
— the server reads its token and keys from the repo .env at start. Restart
Claude Desktop afterwards.
"""

import json
import os
from pathlib import Path

VENV_PYTHON = Path(__file__).resolve().parents[1] / ".venv" / "Scripts" / "python.exe"


def config_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA is not set; Claude Desktop config location is unknown")
    return Path(appdata) / "Claude" / "claude_desktop_config.json"


def register(path: Path) -> None:
    config = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    entry = config.setdefault("mcpServers", {}).setdefault("lifeos", {})
    entry["command"] = str(VENV_PYTHON)
    entry["args"] = ["-m", "mcp_server"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    path = config_path()
    register(path)
    print(f"registered lifeos MCP server in {path}")
    print("restart Claude Desktop to pick it up")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
