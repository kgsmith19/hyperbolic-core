#!/usr/bin/env bash
# Minimal monitoring (#562), every 5 minutes via hyperbolic-core-monitor.timer:
# service health (ops/telemetry.py), the edge answering, disk and memory.
# Problems go to the journal at warning level: `journalctl -t hyperbolic-core -p warning`.
set -uo pipefail
cd "$(readlink -f /srv/hyperbolic-core/current)" || exit 1
warn() { logger -t hyperbolic-core -p user.warning "$*"; echo "WARN $*"; }
python3 ops/telemetry.py --project hyperbolic-core >/dev/null 2>&1 || warn "a compose service is not healthy"
curl -fsS -m 5 http://127.0.0.1:8080/edge/healthz >/dev/null || warn "edge is not answering on 127.0.0.1:8080"
systemctl is-active --quiet cloudflared || warn "cloudflared is not running"
disk="$(df --output=pcent /srv | tail -1 | tr -dc 0-9)"; (( disk < 85 )) || warn "disk /srv at ${disk}%"
mem="$(free | awk '/Mem:/ {printf "%d", $7/$2*100}')"; (( mem > 10 )) || warn "available memory at ${mem}%"
logger -t hyperbolic-core "monitor: disk=${disk}% mem_available=${mem}%"
