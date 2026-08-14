# Handler A (08-llm-handlers.md forced decisions 5/7, pulled forward by
# m3-06 to host Idea Intake's submit API ahead of M4). Node 22, matching
# every other TypeScript workspace in this monorepo (packages/llm,
# platform-client); type-stripped at runtime via Node 22's native
# TypeScript support, no separate build step -- the same convention this
# repo's own `npm test` scripts already rely on for .test.ts files.
#
# Build context is the MONOREPO ROOT, not this directory: `npm ci` needs
# every workspace's package.json to resolve the one shared root
# package-lock.json correctly (an npm workspaces requirement, not a choice
# made for this service specifically). Matches the Brain unit's own
# Dockerfile placement precedent (10-cicd-deployment.md section 2.3: "docker
# buildx of services/brain/Dockerfile") -- build with
# `docker build -f services/llm-handler/Dockerfile .` from the repo root.

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages packages
COPY apps/shell/package.json apps/shell/package.json
COPY apps/toolbelt/package.json apps/toolbelt/package.json
COPY services/llm-handler/package.json services/llm-handler/package.json
RUN npm ci --omit=dev --workspace=@hyperbolic/llm-handler

COPY services/llm-handler/src services/llm-handler/src

LABEL org.opencontainers.image.source="https://github.com/kgsmith19/hyperbolic-core"
LABEL org.opencontainers.image.description="services/llm-handler: Handler A, the general-purpose deployed service (08-llm-handlers.md). Hosts Idea Intake's submit API as its first tenant."

ENV NODE_ENV=production
EXPOSE 8200

ENTRYPOINT ["node", "services/llm-handler/src/index.ts"]
