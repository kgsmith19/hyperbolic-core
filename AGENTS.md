# AGENTS.md

## Repository purpose

`hyperbolic-core` is a monorepo consolidating multiple standalone repos under `apps/<name>/`. Each app was imported via `git subtree` and retains its own upstream `AGENTS.md`, `CLAUDE.md`, and docs, which describe that app as it looked as a standalone repo. Read the nested `AGENTS.md` under an app's directory for that app's actual rules before working in it.

## Workflow safety invariant

The repo-root `.github/workflows/` contains only workflows deliberately activated for `hyperbolic-core` itself. Files under any `apps/*/.github/workflows/` are inert by design — GitHub only executes workflows from a repository's root `.github/workflows/`, never from a nested path — and they must never be copied or moved to the root.

This matters concretely, not just abstractly. `apps/lifeos/.github/workflows/ci.yml` contains a `build-backend` job that, unlike its sibling deploy jobs, has no repository-variable gate on it. If that workflow were ever relocated to the root, `build-backend` would run for real on every push to `main` and publish a Docker image to `ghcr.io/kgsmith19/hyperbolic-core`. That is the kind of accident this rule exists to prevent.

## The platform publishable key has six hardcoded copies

The same Supabase publishable (anon) key literal is hardcoded in six files across five trees:

```
apps/lifeos/frontend/src/lib/session.ts
apps/shell/frontend/src/lib/session.ts
apps/toolbelt/apps/prompt-organizer/frontend/index.html
apps/toolbelt/tests/helpers.mjs
packages/llm/src/prompt-client.ts
packages/platform-client/src/registry.ts
```

This is **not** a leaked secret — a publishable key is public by design, ships in browser bundles, and RLS is the authorization boundary (`registry.ts` says so at its declaration). It is an *operational* hazard: rotating that key means locating and editing six files in five trees, and nothing fails loudly if one is missed — the stale copy just starts 401ing at runtime for whichever surface owns it.

`packages/platform-client` is the shared platform access layer and is the natural single owner. Consolidating is not free: `prompt-organizer`'s copy sits in a plain `index.html` that cannot import a TS package, and not every consumer currently depends on `platform-client`. Treat this as a known hazard to fix deliberately, and if you rotate the key before then, change all six.
