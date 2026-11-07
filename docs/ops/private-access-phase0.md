# Private access, Phase 0 record (#562)

Date: 2026-11-07. Decision: **LifeOS** is the first UI exposed through the Cloudflare
tunnel. Shell has no root compose service, so it cannot be the first proven route.

## Evidence (from the repository, not from a running stack)

- `compose.yaml` publishes LifeOS as `127.0.0.1:${HOST_LIFEOS_PORT:-8000}:8000`. The
  default loopback port is 8000. The bind is loopback, so the origin is not reachable
  from other machines.
- LifeOS has a healthcheck on `http://127.0.0.1:8000/healthz`.

## Still to prove on a Docker host

- `docker compose ps` shows LifeOS healthy on the recorded port.
- `ss -ltnp` shows the port bound to `127.0.0.1`, not `0.0.0.0`.

These checks run on the owner's machine or a Docker runner. They are not run here.
