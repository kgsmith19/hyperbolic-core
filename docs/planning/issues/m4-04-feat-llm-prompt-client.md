Title: FEAT(llm): getPrompt client with pinned-version cache
Type: FEAT
Component: hyperbolic-core
Milestone: M4 The Brain
Depends on: m4-01-feat-llm-core.md, m4-03-feat-po-injection-rpc.md
Blocks: m4-06-feat-intake-optimize.md, m4-09-feat-brain-task-contract.md

## Problem
PO-5 requires consumers to fetch prompts by name with zero schema knowledge; the published contract is the getPrompt signature and the caching strategy of 05-d sections 4 and 6.

## Scope
In scope:
- getPrompt in packages/llm per the 05-d section 6 signature with typed errors
- Cache per 05-d section 4: pinned entries immutable for process lifetime under a 128-entry LRU; name at latest under a 60 s TTL revalidated by the cheapest version_no probe; explicit invalidate; client-side rendering from the cached template
Out of scope:
- Any table-name knowledge in consumers; cross-process cache

## Acceptance criteria
When another component requests a prompt by name through the injection API, the system shall serve it without that component holding schema knowledge (PO-5).
While a prompt is cached at a pinned version, repeat requests shall issue zero network calls (PO-5b).
A cache hit shall return within 5 ms p95.
When the TTL expires and version_no is unchanged, the client shall reuse the cached body with zero body transfer.

## Verification
Scratch script in packages/llm/examples/ using only the published getPrompt contract prints text and version; exit 0
node --test packages/llm/tests/cache.test.mjs (transport spy asserts zero fetches on the second pinned call; revalidation case)
Timed cache-hit case in the same suite

## Estimated LOC delta
Added: 280  Deleted: 0  Net: +280

## Risk
Low; immutability of pinned versions is guaranteed by absent grants, making the cache correct by construction.
