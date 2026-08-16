# @hyperbolic/llm

Provider-agnostic LLM abstraction: request/response/streaming/tool-use
normalization, a closed error taxonomy, and retry/backoff, with drivers for
Anthropic, OpenAI, and Gemini behind one contract.

TypeScript, ESM. Depends on `@anthropic-ai/sdk`, `@google/genai`, and `openai`
as the three provider SDKs the drivers wrap.

This package never stores, reads, or defaults an API key. Credentials are a
plain argument on every call, supplied by the host process (Handler A or the
Brain) — see `Credentials` / `CredentialsByProvider` in `src/types.ts`.

## Usage

```ts
import { complete, createLlmError, isLlmError } from "@hyperbolic/llm";

const response = await complete({
  provider: "anthropic",
  model: "claude-...",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  credentials: { anthropic: { apiKey: "..." } },
});
```

`complete` and `stream` are the orchestration entry points: they run
`withRetry` per hop, dispatch to the registered driver for `request.provider`,
and walk an explicit `fallback: [{provider, model}]` chain on
retryable-exhaustion only. A cross-provider fallback is rejected up front
whenever `tools` is present; same-provider fallback with tools is fine.
Every response/delta names the exact provider+model that actually answered.

`createPromptClient` (`src/prompt-client.ts`) is a separate concern: the
Prompt Organizer injection API (`getPrompt(name, opts?)`), fetched over
PostgREST against a Supabase project, with an LRU + TTL cache for
`name@latest` reads. It throws `PromptNotFoundError` or
`MissingVariablesError` rather than participating in the `LlmError`
taxonomy below.

### Error taxonomy

`createLlmError(class, message, options?)` builds an `Error` tagged with a
`class` from the closed `LlmErrorClass` union (`auth`, `rate_limit`,
`overloaded`, `transport`, `invalid_request`, `content_policy`,
`provider_bug`) and a `retryable` flag derived from `class`, never settable
independently. Only `rate_limit`, `overloaded`, and `transport`
(`RETRYABLE_CLASSES`) ever retry. `isLlmError` is a runtime type guard over
`ALL_ERROR_CLASSES`, safe against a forged or duck-typed error object.

## Layout

```
src/index.ts            public barrel — types, errors, retry, drivers, complete/stream, prompt-client
src/types.ts             provider-agnostic message/request/response contract
src/errors.ts            LlmError taxonomy + createLlmError/isLlmError
src/retry.ts             withRetry, backoff computation, stream-stall handling
src/complete.ts          orchestration: retry + explicit-only fallback + driver dispatch
src/drivers/             one driver per provider (anthropic, gemini, openai) + shared plumbing
src/prompt-client.ts     createPromptClient — the Prompt Organizer injection API
src/prompt-render.ts     pure template rendering used by prompt-client
examples/get-prompt.ts   scratch script demonstrating the getPrompt contract end to end
```

## Documentation

- `src/index.ts`'s header comment records why `apps/shell` deliberately does
  **not** import this package for prompt rendering: this barrel also
  re-exports `complete`/`stream` and all three provider drivers, which pull
  in three server-side-only SDKs that blow a browser bundle budget even when
  only `prompt-render.ts`'s pure functions are wanted. `apps/shell` carries
  its own parity-tested copy instead.
- The root `AGENTS.md`'s "platform publishable key has six hardcoded copies"
  section names `packages/llm/src/prompt-client.ts` as one of the six and
  `packages/llm` as a natural consolidation owner for that hazard.
- `docs/planning/08-llm-handlers.md` (completion contract, fallback rules)
  and `docs/planning/05-d-prompt-organizer.md` sections 4 and 6 (the
  `PromptClient` contract) are this package's specifying documents.
