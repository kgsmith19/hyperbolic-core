"""Proves the release telemetry report fails closed (#504, missing-telemetry)."""

import io
import json
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import telemetry

HEALTHY = [{"Service": "api", "State": "running", "Health": "healthy"},
           {"Service": "db", "State": "running", "Health": "healthy"}]


def fake_compose(rows, declared=("api", "db")):
    def run(project, *args):
        if args[0] == "config":
            return "\n".join(declared)
        return "\n".join(json.dumps(r) for r in rows)
    return run


def main(compose):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = telemetry.main([], compose=compose)
    return code, out.getvalue(), err.getvalue()


class TelemetryTest(unittest.TestCase):
    def test_all_healthy_prints_one_json_report(self):
        """A healthy stack yields a report release.py can digest."""
        code, out, _ = main(fake_compose(HEALTHY))
        self.assertEqual(code, 0)
        self.assertEqual(set(json.loads(out)["services"]), {"api", "db"})

    def test_a_missing_service_fails_with_no_report(self):
        """Catches a declared service that never started being tagged."""
        code, out, err = main(fake_compose(HEALTHY[:1]))
        self.assertEqual((code, out), (1, ""))
        self.assertIn("db: not running", err)

    def test_unhealthy_or_unchecked_services_fail(self):
        """Catches a running but unhealthy, or never health-checked, service."""
        for health in ("unhealthy", "starting", ""):
            with self.subTest(health=health):
                rows = [HEALTHY[0], {"Service": "db", "State": "running", "Health": health}]
                self.assertEqual(main(fake_compose(rows))[0], 1)

    def test_an_exited_service_fails(self):
        rows = [HEALTHY[0], {"Service": "db", "State": "exited", "Health": ""}]
        self.assertEqual(main(fake_compose(rows))[0], 1)

    def test_no_declared_services_fails(self):
        """An empty stack is not observed telemetry."""
        self.assertEqual(main(fake_compose([], declared=()))[0], 1)

    def test_docker_unavailable_fails(self):
        def broken(project, *args):
            raise RuntimeError("docker compose failed")
        self.assertEqual(main(broken)[0], 2)

    def test_parses_array_and_line_formats(self):
        self.assertEqual(telemetry.parse_ps(json.dumps(HEALTHY)), HEALTHY)
        self.assertEqual(telemetry.parse_ps("\n".join(json.dumps(r) for r in HEALTHY)), HEALTHY)


if __name__ == "__main__":
    unittest.main()
