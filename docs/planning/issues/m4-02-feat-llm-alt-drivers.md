Title: FEAT(llm): OpenAI and Gemini drivers with explicit fallback rules
Type: FEAT
Component: hyperbolic-core
Milestone: M4 The Brain
Depends on: m4-01-feat-llm-core.md
Blocks: m4-05-feat-llm-handler-service.md

## Problem
Handler A serves three providers (08-llm-handlers.md section 5), and the Brain's provider reversal trigger depends on the abstraction covering an OpenAI baseline (07-brain-architecture.md section 7.2). Only the Anthropic driver exists after m4-01.

## Scope
In scope:
- OpenAI and Gemini drivers, text and basic tools, per the 08 section 4 contract
- Explicit fallback routing: fail over on retryable exhaustion only; cross-provider fallback with tools attached is invalid_request at the library boundary
Out of scope:
- Provider-specific features beyond text and basic tools (deferred until a consumer needs them)

## Acceptance criteria
When a request carries a fallback list and the primary exhausts retryable errors, the library shall fail over and the response shall name the answering provider.
If a fallback across providers is requested with tools attached, then the library shall reject it as invalid_request before any network call.
Silent cross-provider fallback shall be impossible: with no fallback list, exhaustion shall surface the typed error.

## Verification
node --test packages/llm/tests/fallback.test.mjs (fake transports for all three cases)
node --test packages/llm/tests/drivers/ (per-driver normalization fixtures)

## Estimated LOC delta
Added: 400  Deleted: 0  Net: +400

## Risk
Low; both drivers are stubs of the same normalization surface with fixture-tested parsing.
