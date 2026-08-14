# The Brain daemon (07-brain-architecture.md section 7.3). Node 22,
# matching every other TypeScript workspace in this monorepo; type-stripped
# at runtime via Node 22's native TypeScript support, no separate build
# step. m4-08 ships this minimal image so brain-ci.yml's own build-and-smoke
# step (10-cicd-deployment.md section 1.3) has something real to build and
# run `brain status --offline` inside; m4-21 owns hardening it to the full
# section 3.2 multi-stage spec for production deploy (same "skeleton now,
# harden later" precedent m3-06/m4-05 already established for
# services/llm-handler's own Dockerfile).
#
# Build context is the MONOREPO ROOT: `docker build -f services/brain/Dockerfile .`
# from the repo root (npm workspaces needs every workspace's package.json
# to resolve the one shared root package-lock.json).

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages packages
COPY apps/shell/package.json apps/shell/package.json
COPY apps/toolbelt/package.json apps/toolbelt/package.json
COPY services/llm-handler/package.json services/llm-handler/package.json
COPY services/brain/package.json services/brain/package.json
RUN npm ci --omit=dev --workspace=@hyperbolic/brain

COPY services/brain/src services/brain/src
COPY services/brain/bin services/brain/bin

LABEL org.opencontainers.image.source="https://github.com/kgsmith19/hyperbolic-core"
LABEL org.opencontainers.image.description="services/brain: the Brain daemon (07-brain-architecture.md), a long-lived autonomous-coding orchestrator."

RUN useradd --system --create-home --home-dir /home/brain brain \
  && mkdir -p /data && chown brain:brain /data
USER brain

ENV NODE_ENV=production
EXPOSE 8100
VOLUME ["/data"]

ENTRYPOINT ["node", "services/brain/src/index.ts"]
