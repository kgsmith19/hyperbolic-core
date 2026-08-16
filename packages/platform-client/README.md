# @hyperbolic/platform-client

Shared platform session client (ADR-03): Supabase Auth-backed sign-in,
owner-only session resolution, and an authenticated `fetch` for every
hyperbolic-core zone, plus the Toolbelt registry and Brain PostgREST clients.

TypeScript, ESM. Depends on `@supabase/supabase-js`.

## Usage

```ts
import { createPlatformClient } from "@hyperbolic/platform-client";

const platform = createPlatformClient({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
});

const session = await platform.auth.getSession(); // PlatformSession | null
await platform.fetch("/api/whatever"); // attaches Bearer <accessToken>
```

`createPlatformClient` is the only entry point that can construct a client or
sign a user in — zones other than the Shell should call only
`auth.getSession()`, `auth.onAuthStateChange()`, `auth.signOut()`, and
`fetch`. Every method that can resolve a session enforces the platform-owner
check (`core.is_platform_owner()` RPC) before handing one back; a session
whose subject is not the owner is signed out and resolves as `null` rather
than surfaced to a caller. `fetch` refuses to attach the bearer token to any
request whose resolved origin isn't same-origin-with-the-page or on
`config.additionalAllowedOrigins`.

`createRegistryClient(supabaseUrl, getAccessToken)` (`src/registry.ts`) is the
Shell's only window into `core.app`, the Toolbelt registry table:
`listTools(filter?)` / `getTool(id)` over PostgREST.

`createBrainClient(...)` (`src/brain.ts`) is the typed client for Brain runs,
tasks, and SSE event streaming (`SseLineParser`), plus cost-summary types.

## Layout

```
src/index.ts       createPlatformClient, auth/session/authedFetch wiring, public barrel
src/types.ts        frozen PlatformClient/PlatformAuth/PlatformSession contract (05-a section 6)
src/registry.ts      createRegistryClient — core.app discovery (05-c section 4.3)
src/brain.ts         createBrainClient — runs/tasks/SSE events/cost summaries
```

## Documentation

- `src/types.ts` and `src/registry.ts` are frozen interfaces copied verbatim
  from `docs/planning/05-a-hyperbolic-core.md` section 6 and
  `docs/planning/05-c-toolbelt.md` section 4.3, respectively; treat changes
  to their shapes as cross-cutting.
- ADR-03 (`docs/planning/04-adrs.md`) is the source of the one-IdP,
  owner-only session posture this package enforces.
- `src/index.ts`'s `authedFetch`/`isOwnerSession` doc comments record two
  security findings fixed here: Finding #47 (a merely-authenticated Supabase
  subject is not sufficient — the subject must be the platform owner) and a
  token-exfiltration fix (the origin allowlist on `authedFetch`).
- The root `AGENTS.md`'s "platform publishable key has six hardcoded copies"
  section names `packages/platform-client/src/registry.ts` as one of the six
  hardcoded copies and this package as the natural consolidation owner for
  that hazard.
