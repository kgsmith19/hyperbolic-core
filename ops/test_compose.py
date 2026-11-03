"""Pins the root compose file to the sub-apps it must run (#504, AC1)."""

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = (ROOT / "compose.yaml").read_text()
STORES = json.loads((ROOT / "ops" / "stores.json").read_text())["stores"]

# A tool.json directory (or an app with a server) maps to a compose service,
# or is excluded with its reason in compose.yaml's header.
SERVICE_FOR = {
    "services/platform-api": "platform-api",
    "services/broker": "broker",
    "services/brain": "brain",
    "apps/network-checker": "network-checker",
    "apps/lifeos": "lifeos",
}
EXCLUDED = {
    "services/llm-handler": "llm-handler",
    "apps/idea-intake": "idea-intake",
    "apps/prompt-organizer": "prompt-organizer",
    "apps/shell": "shell",
    "apps/agentic-command-center": "agentic-command-center",
}


def service_blocks():
    """Each top-level service name mapped to its own indented block of compose.yaml."""
    block = COMPOSE.split("\nservices:\n", 1)[1]
    parts = re.split(r"^ {2}([a-z][a-z0-9-]*):[ \t]*\n", block, flags=re.M)
    return dict(zip(parts[1::2], parts[2::2]))


def services():
    return set(service_blocks())


def header():
    return COMPOSE.split("\nname:", 1)[0]


class ComposeTest(unittest.TestCase):
    def test_every_app_and_service_is_in_compose_or_excluded_with_a_reason(self):
        """Catches a new sub-app that silently never runs from `make up`."""
        found = {str(p.parent.relative_to(ROOT)) for p in ROOT.glob("services/*/tool.json")}
        found |= {str(p.parent.relative_to(ROOT)) for p in ROOT.glob("apps/*/tool.json")}
        found |= {str(p.relative_to(ROOT)) for p in (ROOT / "apps").iterdir() if p.is_dir()}
        self.assertEqual(found - set(SERVICE_FOR) - set(EXCLUDED), set())
        self.assertEqual(set(SERVICE_FOR.values()), services())
        for name in EXCLUDED.values():
            self.assertRegex(header(), rf"\b{re.escape(name)}\b", f"{name} needs an exclusion reason")

    def test_every_port_binds_loopback_only(self):
        """Catches a service published on every interface."""
        ports = re.findall(r'^\s+- "([^"]+:\d+)"$', COMPOSE, re.M)
        self.assertTrue(ports)
        for port in ports:
            self.assertTrue(port.startswith("127.0.0.1:"), port)

    def test_every_service_has_a_healthcheck(self):
        """Catches a service `up --wait` and telemetry cannot judge."""
        for name, body in service_blocks().items():
            self.assertRegex(body, r"(?m)^\s+healthcheck:\s*$", f"{name} has no healthcheck")
            self.assertRegex(body, r"(?m)^\s+test:", f"{name} healthcheck has no test")

    def test_stateful_services_write_where_backup_reads(self):
        """Catches state in a docker volume that `make backup` never sees."""
        self.assertNotIn("\nvolumes:\n", COMPOSE)
        for store in STORES:
            host_dir = str(Path(store["file"]).parent).removeprefix("var/")
            self.assertIn(f"${{HYP_VAR:-./var}}/{host_dir}:", COMPOSE, store["app"])


if __name__ == "__main__":
    unittest.main()
