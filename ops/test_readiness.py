import subprocess
import unittest
from datetime import UTC, datetime

from local_stack import COMPONENTS, composed_components, excluded_components
from readiness import ComposeObservation, compose_status, render


class ReadinessTest(unittest.TestCase):
    def test_report_accounts_for_every_local_component(self):
        report = render(ComposeObservation({}), datetime(2026, 11, 7, tzinfo=UTC))
        for component in COMPONENTS:
            self.assertIn(f"`{component.name}`", report)
        self.assertIn("not running", report)
        self.assertIn("external dependency", report)
        self.assertIn("tests only", report)

    def test_running_compose_service_is_reported_without_hiding_missing_services(self):
        report = render(ComposeObservation({"platform-api": "healthy"}), datetime(2026, 11, 7, tzinfo=UTC))
        self.assertIn("`platform-api` | http://platform.localhost:8400 | running", report)
        self.assertIn("docker compose reports `healthy`", report)
        self.assertIn("`broker` | http://127.0.0.1:8300/healthz | not running", report)

    def test_unavailable_docker_returns_an_honest_empty_status(self):
        def unavailable(*_args, **_kwargs):
            return subprocess.CompletedProcess([], 1, "", "Cannot connect to the Docker daemon")

        observation = compose_status(unavailable)
        self.assertEqual(observation.services, {})
        self.assertIn("Cannot connect", observation.unavailable_reason or "")

    def test_missing_docker_command_returns_an_honest_empty_status(self):
        def missing_binary(*_args, **_kwargs):
            raise FileNotFoundError("docker")

        observation = compose_status(missing_binary)
        self.assertEqual(observation.services, {})
        self.assertIn("not installed", observation.unavailable_reason or "")

    def test_report_names_the_missing_docker_prerequisite(self):
        report = render(ComposeObservation({}, "Docker is not installed or is not on PATH"))
        self.assertIn("prerequisite blocked", report)
        self.assertIn("install or start Docker", report)

    def test_inventory_partitions_compose_and_excluded_components(self):
        self.assertEqual(set(COMPONENTS), set(composed_components()) | set(excluded_components()))
        self.assertFalse(set(composed_components()) & set(excluded_components()))


if __name__ == "__main__":
    unittest.main()
