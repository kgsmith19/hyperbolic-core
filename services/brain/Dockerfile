# The Brain daemon (07-brain-architecture.md section 7.3; multi-stage spec
# 10-cicd-deployment.md section 3.2). Node 22, matching every other
# TypeScript workspace in this monorepo; type-stripped at runtime via
# Node 22's native TypeScript support, no separate JS build step -- "compile"
# below means `tsc -b` type-checking only, the same thing `npm run
# typecheck` already runs on a bare runner in brain-ci.yml.
#
# m4-08 shipped a minimal single-stage image so brain-ci.yml's own
# build-and-smoke step had something real to build and run
# `brain status --offline` inside; m4-10 added `git` (worktree.ts) and the
# ACC kernel subprocess tree the claude-code adapter spawns
# (adapters/claude-code.ts). m4-21 (this revision) hardens it to the full
# section 3.2 spec: a `build` stage that installs devDependencies, type-
# checks, and prunes back to production-only `node_modules`; a `runtime`
# stage that copies only that pruned tree plus source, installs the real
# `claude` CLI (`@anthropic-ai/claude-code`, the package
# adapters/claude-code.ts's `execFileAsync("claude", ...)` identity probe
# expects on PATH) system-wide before dropping root, and runs as the
# non-root `brain` system user with a fixed uid -- ADR-05's isolation
# mechanism (dedicated OS user + container boundary, isolation-check.mjs's
# own header comment). Still no ACC_POLICY/ACC_VAULT content baked in: the
# image ships the kernel's default `policy.json` and an EMPTY vault
# directory, provisioned for real at deploy time (compose `secrets:`,
# section 6) -- baking a real vault into a versioned image would put the
# Brain's own key inside a ghcr.io layer, exactly what ADR-05 exists to
# prevent.
#
# UNVERIFIED in this sandbox: no Docker daemon is available here (`docker
# info` fails to reach a socket), so this build has not actually been run
# locally. brain-ci.yml's own "Build the Brain image" / "Smoke-run" steps
# are what prove it on a real runner, on every PR that touches this file.
#
# Build context is the MONOREPO ROOT: `docker build -f services/brain/Dockerfile .`
# from the repo root (npm workspaces needs every workspace's package.json
# to resolve the one shared root package-lock.json).

FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages packages
COPY apps/shell/package.json apps/shell/package.json
COPY apps/toolbelt/package.json apps/toolbelt/package.json
COPY services/llm-handler/package.json services/llm-handler/package.json
COPY services/brain/package.json services/brain/package.json
COPY services/brain/tsconfig.json services/brain/tsconfig.json
# devDependencies included (typescript, @types/node) -- this stage's own
# node_modules never ships; only the pruned copy below does.
RUN npm ci --workspace=@hyperbolic/brain

COPY services/brain/src services/brain/src
COPY services/brain/bin services/brain/bin

# Fails the image build itself on a type error, the same gate brain-ci.yml
# already runs on a bare runner -- redundant with that PR check by design
# (a build run from a stale/unchecked ref should still refuse to ship).
RUN npm run typecheck --workspace=@hyperbolic/brain

# Removes typescript/@types/node and every other devDependency from the
# already-resolved tree, in place -- the runtime stage below copies this
# same directory, never node_modules from a fresh install of its own.
RUN npm prune --omit=dev

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# The real Claude Code CLI (adapters/claude-code.ts's `execFileAsync("claude",
# ["--version"], ...)` identity probe resolves this via PATH, not a
# repo-relative path -- installed globally, before USER brain, so every
# invocation regardless of which OS user starts the daemon can find it).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/services/brain/package.json services/brain/package.json
COPY --from=build /app/services/brain/src services/brain/src
COPY --from=build /app/services/brain/bin services/brain/bin

# apps/agentic-command-center is NOT an npm workspace (its own
# package.json carries zero dependencies -- kernel/hooks/runner are pure
# Node-built-in .mjs, confirmed by grepping their imports) and has no
# UI/GUI/Windows-only pieces the Brain's headless subprocess spawn needs
# (apps/agentic-command-center/frontend and backend/{gui,shim,watcher} are
# deliberately NOT copied). config.ts's default BRAIN_KERNEL_RUN_PATH
# assumes this exact relative layout is preserved. backend/policy.json must
# keep landing one level above backend/kernel: every backend module resolves
# its root as HERE/".." and would otherwise read a policy that isn't there.
# Copied directly from the build context (never routed through the `build`
# stage above, which only ever ran `npm ci`/`tsc` over the npm-workspace tree
# these plain .mjs files are not part of).
COPY apps/agentic-command-center/backend/kernel apps/agentic-command-center/backend/kernel
COPY apps/agentic-command-center/backend/hooks apps/agentic-command-center/backend/hooks
COPY apps/agentic-command-center/backend/runner apps/agentic-command-center/backend/runner
COPY apps/agentic-command-center/backend/policy.json apps/agentic-command-center/backend/policy.json
# kernel/settings.mjs's guardMjsPath()/guardsCliPath() default to this
# exact sibling path (../../../toolbelt/guards relative to backend/kernel/)
# unless ACC_GUARDS_HOOK/ACC_GUARDS_CLI override it -- m4-07's automatic,
# fail-closed guard registration depends on this being present.
COPY apps/toolbelt/guards apps/toolbelt/guards

LABEL org.opencontainers.image.source="https://github.com/kgsmith19/hyperbolic-core"
LABEL org.opencontainers.image.description="services/brain: the Brain daemon (07-brain-architecture.md), a long-lived autonomous-coding orchestrator."

# Fixed uid (ADR-05 isolation point 2, 04-adrs.md): a stable, predictable
# id rather than whatever the next `useradd` happens to allocate, so a
# host-side bind mount's ownership stays correct across image rebuilds.
RUN useradd --system --uid 10100 --create-home --home-dir /home/brain brain \
  && mkdir -p /data /workspaces && chown brain:brain /data /workspaces
USER brain

ENV NODE_ENV=production
EXPOSE 8100
VOLUME ["/data", "/workspaces"]

# The lifeos in-container healthcheck pattern (compose.yaml section 3.2's
# own reference point): plain fetch, no curl dependency, matching
# services/llm-handler/compose.yaml's identical check shape.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8100/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["node", "services/brain/src/index.ts"]
