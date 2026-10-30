# The local platform service (#508). Build context is the repo root: npm
# workspaces need every member's package.json to resolve the one lockfile.
# Node 22 type-strips TypeScript natively, so there is no build step.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sqlite-kit packages/sqlite-kit
COPY services/platform-api services/platform-api
RUN npm ci --omit=dev --workspace=@hyperbolic/platform-api

ENV PLATFORM_DB_PATH=/data/platform.db \
    PLATFORM_HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 8400
WORKDIR /app/services/platform-api
CMD ["node", "src/index.ts"]
