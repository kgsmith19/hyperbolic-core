# Test Ledger

The suites for `packages/llm`. All of them run in the `Shell PR Gate`
(`.github/workflows/shell-ci.yml`).

| Suite | Covers | Command |
| --- | --- | --- |
| `tests/` | Request, response, streaming, and tool-use normalization, the error taxonomy, and retry/backoff across the Anthropic, OpenAI, and Gemini drivers. | `npm test` |

Add a row when a new suite is introduced. This ledger is historical context for
contributors, not a merge gate — `Shell PR Gate` is the gate.
