# Stdlib only, per AGENTS.md -- there is nothing to `pip install`, so there
# is no build stage. This just packages the interpreter and the source tree.
#
# Caveat (see docs/notes/2026-08-07-deploying-and-releasing-netcheck.md): environ.py's Wi-Fi/driver/event-log/MTU
# checks shell out to Windows-only tools (netsh, PowerShell) or, since Phase
# 26, macOS's airport -- none of which exist in this Linux image. Inside a
# container, `full-check`/`diagnose`/`serve` still work for the checks that
# don't need host-specific tooling (Anthropic status, DNS, TLS, HTTP,
# NAT/CGNAT detection); the Wi-Fi-adjacent sections report `unavailable`,
# same as running on a wired-only machine.
FROM python:3.12-slim

LABEL org.opencontainers.image.source="https://github.com/kgsmith19/hyperbolic-core"
LABEL org.opencontainers.image.description="netcheck: which-layer network diagnostic for LLM API connections"

WORKDIR /app
COPY netcheck ./netcheck
COPY frontend ./frontend
COPY AGENTS.md README.md ./

# SQLite is the source of truth (see README.md); keep it on a mountable
# volume so a container restart doesn't lose history.
ENV NETCHECK_DB=/data/netcheck.db
VOLUME ["/data"]
EXPOSE 8787

ENTRYPOINT ["python", "-m", "netcheck"]
CMD ["--help"]
