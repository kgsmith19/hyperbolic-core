# RULE 06: TESTS

A test is a liability that earns its keep by catching a specific failure. Quality over quantity. Every test is justified or deleted.

## Property kinds

Walk **all nine** when writing a spec. For each, write the property or one line saying why the kind does not apply. The kinds you would not have thought of are the ones that find bugs.

| Kind | The question | Watch for |
|---|---|---|
| Error totality | Does every input in the domain end in a named success or named error, never a crash or partial write? | **Check this first. It applies almost always.** |
| Round-trip | Is there an inverse? `decode(encode(x)) == x` | Encoding, timezone, float precision, Unicode normalization |
| Invariant | What is always true of the result? | State the strongest postcondition, not the weakest |
| Idempotence | Is doing it twice the same as once? | Retries, webhooks, at-least-once delivery, double-click |
| Order independence | Does sequence matter? | Concurrency bugs hide exactly here |
| Oracle / model | Is there a slow, obviously-correct version to compare against? | Highest-value kind when it applies |
| Metamorphic | If input shifts, how must output shift? | Use when no oracle exists |
| Conservation | Is a total preserved? | Money, inventory, counts |
| Monotonicity | Does more in mean never less out? | Pagination, filtering, scoring, rate limits |

## Generator domains

A property is only as good as its domain. Vague domains produce vacuous passes.

| Field | Sufficient precision |
|---|---|
| Bounds | Integers `-2^31` to `2^31 - 1` inclusive |
| Structure | Non-empty lists of 1 to 500 elements |
| Text edge values | empty, whitespace-only, 1 char, max length, emoji, RTL marks, combining characters, `NUL`, SQL and HTML metacharacters |
| Time edge values | DST transitions both directions, leap day, epoch, year 2038, naive vs aware |
| Number edge values | `0`, negative zero, `NaN`, infinities, float precision loss, exact-decimal currency |
| Seed | Pinned and recorded. A property that cannot reproduce its failure is a rumor. |
| Shrinking | On, producing a minimal counterexample |

## Cheaper than a test

Before writing any test, find the cheaper mechanism. Record every elimination, because in six months nobody remembers the reasoning and re-adds the test.

| Instead of testing | Use |
|---|---|
| A field is never null | `NOT NULL` |
| A value is unique | `UNIQUE` |
| A reference exists | Foreign key |
| A value is in a set | `CHECK` or an enum |
| A caller cannot pass the wrong type | The type system |
| A payload has required fields | Schema validation once at the boundary |
| A user cannot read another's row | An RLS policy + **one** test that the policy is on |
| A bad state cannot occur | Make it unrepresentable |
| Formatting or style | A lint rule |
| Config exists at boot | A startup assertion that fails loudly |

## Levels

Cheapest level that can catch it wins.

| Level | ID | Catches | Does not catch | Per slice |
|---|---|---|---|---|
| Unit | `T-U-` | Logic in one function or module | Wiring, contracts, config | most |
| Property | counted as unit | Whole input classes examples missed | Integration, cross-service ordering | 1-3 |
| Integration | `T-I-` | Wrong contract where two real components meet | Full journeys | 0-2 |
| Acceptance | `T-A-` | The `AC` as written, from outside | Internal correctness | 1 per `AC` |
| E2E | `T-E-` | The critical path through the real stack | Anything cheap | 0-1, revenue or safety only |
| Regression | `T-R-` | A bug that actually happened | Bugs that never happened | 1 per fixed defect, never speculative |

Target shape: ~70% unit, ~20% integration, ~5% E2E, rest acceptance and regression. An inverted shape is a strategy defect.

## Banned tests

No exceptions.

- Tests of framework or library behavior
- Tests where a mock is the only thing asserted on
- Getter/setter tests
- Snapshot tests with no human-reviewed intent
- Tests written to raise a coverage number
- Tests duplicating an assertion already made at a cheaper level
- Tests asserting on log output, unless an `NFR` requires the log
- Tests asserting on internal state instead of public behavior

## Writing rules

| Rule | Reason |
|---|---|
| Name states the behavior: `rejects_token_expired_by_one_second__T_U_014__FR_009` | `test_create_user` tells you nothing at 3am |
| One reason to fail per test | Three assertions on different concerns is three tests wearing a coat |
| Arrange-Act-Assert, visibly separated | Reviewability |
| No `if`, no loops around assertions | Branches in tests are untested branches |
| No shared mutable state | Order dependence is a silent killer |
| Real objects over mocks; mock only what you do not own and cannot run | Mocks assert your beliefs, not the system |
| Pin every clock, seed, and UUID source | Determinism, GATE-TEST-JUSTIFIED J8 |
| No sleeps. Poll a condition with a timeout. | |

## Mutation verification

For every test: break the code in the exact way the test claims to catch, confirm red, revert, record the date in the ledger.

Mutations worth trying: invert a condition, off-by-one a boundary, swap two arguments, return a constant, delete the validation line, skip the persistence call, return stale data.

**If no mutation turns any test red, you have a hole exactly where you believed you had coverage.** That is the most valuable finding the test workflow produces.

For a surviving mutant, choose one: a real gap (add one test), an equivalent mutant (record and ignore), or **code no requirement demands (delete the code)**. The third is the best outcome and happens more often than expected.

## Coverage

Coverage is a **diagnostic, never a target.** Read it to find uncovered code, not to raise a number.

| Uncovered code | Verdict |
|---|---|
| Implements a PRD requirement | Real gap. One test at the cheapest level. |
| Implements nothing in the PRD | Delete the code |
| Error path that cannot occur | Delete the path |
| Defensive check the type system guarantees | Delete the check |

**Never add a test solely to raise coverage.**

## Ledger

`specs/TEST-LEDGER.md`, from `templates/TEST-LEDGER.md`. Every test has a row, written **before** the test. No row, no test. Updated in the same commit as the test.

Required columns: test id, location, level, traces-to (two hops), failure mode in user-observable terms, why not cheaper, why not duplicate, mutation-verified date, runtime, deletion criterion.

Quarantine is capped at 14 days. A test nobody will fix in two weeks is a test nobody needs.
