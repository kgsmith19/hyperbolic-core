# services/broker (Epic #182, issue #185): log-only pass-through skeleton for
# the guards broker -- proves the deploy path and request plumbing work
# before anything is actually enforced (credential injection is #186, egress
# allowlisting is #187, budget enforcement is #188). Node 22, matching every
# other TypeScript workspace in this monorepo; type-stripped at runtime via
# Node 22's native TypeScript support, no separate build step.
#
# Build context is the MONOREPO ROOT, not this directory -- same reason as
# services/llm-handler/Dockerfile's own header comment: npm workspaces need
# every workspace's package.json to resolve the one shared root
# package-lock.json. Build with `docker build -f services/broker/Dockerfile .`
# from the repo root.

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages packages
COPY apps/shell/package.json apps/shell/package.json
COPY apps/toolbelt/package.json apps/toolbelt/package.json
COPY services/broker/package.json services/broker/package.json
RUN npm ci --omit=dev --workspace=@hyperbolic/broker

COPY services/broker/src services/broker/src

LABEL org.opencontainers.image.source="https://github.com/kgsmith19/hyperbolic-core"
LABEL org.opencontainers.image.description="services/broker: the guards broker (Epic #182). Log-only pass-through in this phase -- logs every proxied request and forwards it unmodified, no enforcement yet."

# Fixed uid, same reasoning as services/brain (10100) and services/llm-handler
# (10200): a stable, predictable id rather than whatever the next `useradd`
# allocates, so any host-side bind mount's ownership survives image rebuilds.
RUN useradd --system --uid 10300 --create-home --home-dir /home/broker broker
USER broker

ENV NODE_ENV=production
EXPOSE 8300

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8300/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["node", "services/broker/src/index.ts"]
