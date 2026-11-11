# Production Shell (#562): the Vite build served as static files by Caddy,
# which is also the single same-origin reverse proxy for the platform APIs
# (ops/cloud/Caddyfile). Never the Vite dev server.
#
# Build context is the repository root (npm workspaces). VITE_* values are
# compiled into the bundle, so they must be public: the anon key is a
# public client key, not a secret.
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The whole workspace (minus .dockerignore): the Shell builds @hyperbolic/ui
# and links @hyperbolic/platform-client, exactly as `npm ci` does locally.
COPY . .
RUN npm ci --no-audit --no-fund
ARG PUBLIC_ORIGIN=https://core.kylegsmith.com
ARG VITE_PLATFORM_ANON_KEY=local
ARG BUILD_SHA=unknown
ENV VITE_PLATFORM_URL=${PUBLIC_ORIGIN}/platform \
    VITE_BRAIN_API=${PUBLIC_ORIGIN} \
    VITE_LIFEOS_API=${PUBLIC_ORIGIN}/life/api \
    VITE_PLATFORM_ANON_KEY=${VITE_PLATFORM_ANON_KEY}
RUN npm run build --workspace=shell
# LifeOS's own UI bundle (base /life/), linked from the Shell's LifeOS zone.
# Its own lockfile; @hyperbolic/ui is already built by the Shell step above.
ENV VITE_API_URL=${PUBLIC_ORIGIN}/life/api
RUN cd apps/lifeos/frontend && npm ci --no-audit --no-fund && npm run build

FROM caddy:2.10-alpine
COPY --from=build /app/apps/shell/frontend/dist /srv/shell
COPY --from=build /app/apps/lifeos/frontend/dist /srv/life
COPY ops/cloud/Caddyfile /etc/caddy/Caddyfile
LABEL org.opencontainers.image.source="https://github.com/kgsmith19/hyperbolic-core" \
      org.opencontainers.image.description="hyperbolic-core edge: production Shell + same-origin proxy" \
      hyperbolic-core.app="shell"
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/edge/healthz >/dev/null || exit 1
