Title: FEAT(llm): provider abstraction core with the Anthropic driver
Type: FEAT
Component: hyperbolic-core
Milestone: M4 The Brain
Depends on: m1-01-chore-platform-workspace-setup.md
Blocks: m4-02-feat-llm-alt-drivers.md, m4-04-feat-llm-prompt-client.md, m4-05-feat-llm-handler-service.md

## Problem
Forced decision 6 builds one provider library rather than adopting a proxy; the abstraction (request/response/streaming/tool-use normalization, error taxonomy, retry) is the expensive part that must exist exactly once (08-llm-handlers.md sections 2-4). The library contract is 08 section 4.

## Scope
In scope:
- packages/llm contracts per 08 section 4 (LlmRequest, LlmResponse, LlmDelta, LlmError), retry and backoff discipline, timeout and stream-stall rules, the Anthropic driver complete (streaming, tools, cache-read usage)
- Zero key handling: drivers receive credentials per call from the host process
Out of scope:
- OpenAI and Gemini drivers (m4-02); Handler A service (m4-05); prompt client (m4-04)

## Acceptance criteria
When a retryable error class occurs, the library shall retry at most 2 times with full-jitter backoff and shall honor retryAfterMs; invalid_request and content_policy shall never retry.
When a stream produces no delta for 60 seconds, the call shall abort classified transport.
The package shall store, read, or default no API key: a grep for provider key env names shall return zero hits.
Every response shall name the provider and model that answered.

## Verification
node --test packages/llm/tests/ (fake-transport retry, taxonomy, and stall cases)
grep -rn "ANTHROPIC_API_KEY\|OPENAI_API_KEY\|GEMINI_API_KEY\|GOOGLE_API_KEY" packages/llm/src returns zero hits
npx tsc -b packages/llm

## Estimated LOC delta
Added: 700  Deleted: 0  Net: +700

## Risk
Low; mirrors the proven lane retry discipline; contract shared by both handler instances.
