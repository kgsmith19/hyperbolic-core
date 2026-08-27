# @hyperbolic/review

Adversarial LLM PR review, built on [`@hyperbolic/llm`](../llm). Powers the repo-wide
`LLM Review` gate (`.github/workflows/llm-review.yml`) and runs identically on your machine.

## What it judges

Against the PR's linked Issue and the root `AGENTS.md`:

1. Does the diff actually satisfy the Issue's stated behavior claims?
2. Test-first — is there a test that could have failed before this change, for the right reason?
3. Do tests assert real **behavior**, rather than restating setup, mocking the unit under test, or
   asserting only that a mock was called when the call isn't the contract?
4. Is coverage high-ROI, or bloat added to turn things green?
5. Does the change respect `AGENTS.md`'s Test quality and Lean engineering sections?

Every finding must carry concrete evidence **and** a citation to an acceptance criterion or a
named `AGENTS.md` section. Findings without both are discarded and cannot block.

## Design guarantees

| Property | Why |
| --- | --- |
| The model gets a **structured-output tool only** — no shell, file, or network access | Content under review is untrusted. Injected text can skew a verdict; it cannot execute anything or reach a credential. |
| **Reviewer provider ≠ builder provider**, enforced in `config.ts` | A model family reviewing its own work is not independent verification. Fails closed when they match. |
| **The builder identity is stated, never assumed** | `REVIEW_BUILDER_PROVIDER` and `DEV_MODEL` are both required. An assumed builder made separation hold by coincidence for one reviewer family and not at all for the others. |
| **No model ID is ever defaulted** | `@hyperbolic/llm` never defaults a model silently, and a stale hardcoded ID is an unverified claim. `REVIEW_MODEL` is required. |
| Credentials are an **explicit argument**, never read by the library | Inherited from `@hyperbolic/llm`'s zero-key-handling invariant. |
| Infra failure blocks; a weak model answer does not | You cannot claim a review happened if it didn't — but a confused model must not stall real work. |

## Run it locally

```bash
npm ci                                    # from the repo root

export REVIEW_PROVIDER=gemini             # must differ from the builder family
export REVIEW_MODEL=<exact-model-id>      # required; never defaulted
export REVIEW_GEMINI_API_KEY=<key>        # only the reviewer's key is needed
export REVIEW_BUILDER_PROVIDER=anthropic  # required; the family that WROTE the change
export DEV_MODEL=<exact-model-id>         # required; the exact model that wrote it

node packages/review/bin/review.mjs \
  --base "$(git merge-base main HEAD)" \
  --head HEAD \
  --issue-body-file /tmp/issue.md \
  --pr-body-file /tmp/pr-body.md \
  --out /tmp/review.json
```

Nothing above is defaulted — an unset `REVIEW_BUILDER_PROVIDER` or `DEV_MODEL` fails the run by
name rather than resolving to a guess. Exit codes: **0** pass, **1** blocking findings,
**2** infrastructure/config failure.

## Test

```bash
node --test packages/review/tests/*.test.ts
npm run typecheck --workspace=@hyperbolic/review
```

The suite includes both controls that matter: a valid blocking finding **does** block, and an
uncited one **does not** — this package must not commit the green-washing sin it polices.
