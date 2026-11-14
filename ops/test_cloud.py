"""Pins the cloud overlay and its operator scripts (#562).

The host must never publish a service on a public interface: compose.cloud.yaml
resets every base service's ports and gives only `edge` one loopback port, which
the host's cloudflared reaches. Each script must at least parse.
"""

import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = (ROOT / "compose.yaml").read_text()
CLOUD = (ROOT / "compose.cloud.yaml").read_text()


def blocks(text):
    body = text.split("\nservices:\n", 1)[1]
    parts = re.split(r"^ {2}([a-z][a-z0-9-]*):[ \t]*\n", body, flags=re.M)
    return dict(zip(parts[1::2], parts[2::2]))


class CloudOverlayTest(unittest.TestCase):
    def test_every_base_service_drops_its_host_ports(self):
        cloud = blocks(CLOUD)
        for name in blocks(BASE):
            self.assertIn(name, cloud, f"{name} is not overridden in compose.cloud.yaml")
            self.assertRegex(cloud[name], r"(?m)^\s+ports: !reset \[\]\s*$", f"{name} keeps host ports")

    def test_only_edge_publishes_and_only_on_loopback(self):
        ports = re.findall(r'^\s+- "([^"]+:\d+)"$', CLOUD, re.M)
        self.assertEqual(ports, ["127.0.0.1:8080:8080"])
        self.assertIn("8080", blocks(CLOUD)["edge"])

    def test_brain_key_is_mounted_into_brain_only(self):
        mounts = {name: "/run/secrets/brain/anthropic-api-key" in body for name, body in blocks(CLOUD).items()}
        self.assertEqual([n for n, has in mounts.items() if has], ["brain"])

    def test_edge_routes_never_reach_internal_services(self):
        caddy = (ROOT / "ops/cloud/Caddyfile").read_text()
        upstreams = set(re.findall(r"reverse_proxy\s+([a-z0-9-]+):\d+", caddy))
        # lifeos-mcp (#633) is reached only behind the "LifeOS MCP" Access app and cloudflared's
        # aud_tag check, and refuses unauthenticated calls itself.
        self.assertEqual(upstreams, {"platform-api", "lifeos", "lifeos-mcp", "brain"})
        self.assertIn("admin off", caddy)

    def test_cloud_init_opens_nothing(self):
        init = (ROOT / "ops/cloud/cloud-init.yaml").read_text()
        self.assertIn("ListenAddress 127.0.0.1", init)
        self.assertIn("PasswordAuthentication no", init)
        provision = (ROOT / "ops/cloud/provision.sh").read_text()
        self.assertRegex(provision, r'rules\\?":\[\]')

    def test_scripts_parse(self):
        for script in [*ROOT.glob("ops/cloud/*.sh"), *ROOT.glob("ops/cloud/host/*.sh"), ROOT / "infra/cloudflare/cf.sh"]:
            subprocess.run(["bash", "-n", str(script)], check=True)

    def test_tunnel_requires_access_on_every_hostname(self):
        tf = (ROOT / "infra/cloudflare/main.tf").read_text()
        hostnames = re.findall(r"hostname = (local\.\w+)", tf)
        self.assertEqual(sorted(hostnames), ["local.core_host", "local.ops_host"])
        self.assertEqual(tf.count("required  = true"), 2)
        self.assertIn('service = "http_status:404"', tf)


if __name__ == "__main__":
    unittest.main()
