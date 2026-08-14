# The Brain daemon (07-brain-architecture.md section 7.3). Node 22,
# matching every other TypeScript workspace in this monorepo; type-stripped
# at runtime via Node 22's native TypeScript support, no separate build
# step. m4-08 shipped this minimal image so brain-ci.yml's own
# build-and-smoke step (10-cicd-deployment.md section 1.3) has something
# real to build and run `brain status --offline` inside; m4-10 adds `git`
# (worktree.ts) and the ACC kernel subprocess tree the claude-code adapter
# spawns (adapters/claude-code.ts). Still not the full production image:
# m4-21 owns hardening this to the full section 3.2 multi-stage spec (real
# `claude` CLI install, real ACC_POLICY/ACC_VAULT provisioning) -- same
# "skeleton now, harden later" precedent m3-06/m4-05 already established
# for services/llm-handler's own Dockerfile. UNVERIFIED in this sandbox:
# no Docker daemon is available here (see the PR body), so this build has
# not actually been run.
#
# Build context is the MONOREPO ROOT: `docker build -f services/brain/Dockerfile .`
# from the repo root (npm workspaces needs every workspace's package.json
# to resolve the one shared root package-lock.json).

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

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

# apps/agentic-command-center is NOT an npm workspace (its own
# package.json carries zero dependencies -- kernel/hooks/runner are pure
# Node-built-in .mjs, confirmed by grepping their imports) and has no
# UI/GUI/Windows-only pieces the Brain's headless subprocess spawn needs
# (apps/agentic-command-center/{ui,gui,shim,watcher,forgepad} are
# deliberately NOT copied). config.ts's default BRAIN_KERNEL_RUN_PATH
# assumes this exact relative layout is preserved.
COPY apps/agentic-command-center/kernel apps/agentic-command-center/kernel
COPY apps/agentic-command-center/hooks apps/agentic-command-center/hooks
COPY apps/agentic-command-center/runner apps/agentic-command-center/runner
COPY apps/agentic-command-center/policy.json apps/agentic-command-center/policy.json
# kernel/settings.mjs's guardMjsPath()/guardsCliPath() default to this
# exact sibling path (../../toolbelt/guards relative to kernel/) unless
# ACC_GUARDS_HOOK/ACC_GUARDS_CLI override it -- m4-07's automatic,
# fail-closed guard registration depends on this being present.
COPY apps/toolbelt/guards apps/toolbelt/guards

LABEL org.opencontainers.image.source="https://github.com/kgsmith19/hyperbolic-core"
LABEL org.opencontainers.image.description="services/brain: the Brain daemon (07-brain-architecture.md), a long-lived autonomous-coding orchestrator."

RUN useradd --system --create-home --home-dir /home/brain brain \
  && mkdir -p /data /workspaces && chown brain:brain /data /workspaces
USER brain

ENV NODE_ENV=production
EXPOSE 8100
VOLUME ["/data", "/workspaces"]

ENTRYPOINT ["node", "services/brain/src/index.ts"]
