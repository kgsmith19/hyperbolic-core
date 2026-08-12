---
title: <decision stated as an outcome, e.g. "Use Postgres, not DynamoDB">
status: proposed | accepted | superseded
scope: repo
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
owner: <name>
traces: [NFR-004, CON-002]
supersedes: <ADR-NNNN or none>
superseded_by: <ADR-NNNN or none>
---

# ADR-NNNN: <decision stated as an outcome>

> Write an ADR only when the decision has real trade-offs **and** is expensive to reverse. A decision with an obvious answer does not need a document. Keep this under 80 lines.
>
> **Never edit an accepted ADR to change the decision.** Write a new one that supersedes it and link both ways. The history is the point.

## Context

<What is true that forces a decision now. Two to five sentences. No solutions here.>

## Decision

<One sentence, present tense: "We use X for Y.">

## Options considered

| Option | How it works | Maturity cost | Migration cost if we leave | Lock-in | Ecosystem gaps |
|---|---|---|---|---|---|
| **<chosen>** | | | | | |
| <rejected> | | | | | |
| <rejected> | | | | | |

Every row must be filled. An option with no stated cost was not seriously considered, and saying so is more honest than inventing a comparison.

## Why the chosen option

<The first-principles reason. Not "it is popular" or "it is what we know". What physical or logical necessity does it satisfy that the others do not?>

## Consequences

| | |
|---|---|
| We can now | <what this makes possible> |
| We can no longer | <what this rules out> |
| We must maintain | <ongoing cost> |
| We are exposed to | <the risk we accepted> |

## Reversal

| Field | Answer |
|---|---|
| Cost to reverse | low / medium / high, with the concrete work |
| What would trigger a reversal | <objective condition> |
| What is proprietary and would not transfer | <list, or "nothing"> |

## Verification

<How we will know within 90 days whether this was right. A number, and where it is measured.>
