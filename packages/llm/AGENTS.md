# AGENTS.md

## 🎯 Purpose

`@hyperbolic/llm` is a provider-agnostic LLM abstraction: request, response, streaming, and tool-use normalization, an error taxonomy, and retry/backoff, with Anthropic, OpenAI, and Gemini drivers. It is a private workspace package consumed by other zones in `hyperbolic-core`.

## 📋 Product Boundaries

- Zero key handling. Callers pass credentials in per call; this package never reads them from the environment and never stores them.
- Drivers normalize to the shared contract. Provider-specific behavior must not leak into the public surface.
- `src/prompt-client.ts` holds one of the six hardcoded copies of the platform publishable key. See the repo-root `AGENTS.md`: rotating that key means editing all six.
- Importing this package into a browser bundle pulls in three provider SDKs. `apps/shell` deliberately ports two modules rather than importing it, to stay inside its size budget — see `apps/shell/TEST_LEDGER.md`.
- Make the smallest clear change that completely resolves its linked GitHub Issue.
- Preserve behavior-focused tests; never weaken assertions to make a gate pass.

## ⚙️ Commands

```bash
npm test          # node --test tests/
npm run typecheck # tsc -b . && tsc -p tsconfig.test.json
```

## ✅ Completion Criteria

GitHub Issues are the durable work source. A change is ready when its linked Issue's acceptance criteria are satisfied, the commands above pass, and the root's `Verify: Tests (Linux)` gate succeeds — it covers `packages/**`.

## 🔒 Collaboration Boundary

AI coding agents may create assigned branches, commits, Issues, and pull requests. They must not submit reviews, approve or block pull requests, request reviewers, or post unsolicited comments. They may answer in an Issue or pull request only when explicitly tagged with a direct question.
