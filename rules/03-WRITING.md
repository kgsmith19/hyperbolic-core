# RULE 03: WRITING

Applies to every artifact this system produces: PRD, system requirements, DFD, specs, ADRs, notes, README, commit messages, PR descriptions.

## The four-reader test

Every sentence must be understood identically by all four of: **a child, a non-technical business person, a programmer, and an LLM.** If any could read it two ways, rewrite it.

## Rules

1. **One statement, one requirement.** If it contains "and", check whether it is two.
2. **"must" / "must not" / "may".** Never "should", "could", "would be nice", "ideally".
3. **No adjective without a number.** Not "fast" but "responds in under 200 ms at p95". Not "secure" but "rejects requests without a valid signature".
4. **Active voice, present tense, named actor.** "The system rejects the request", not "requests will be rejected".
5. **Define each term once** in the Glossary, then use it identically forever. No synonyms for one concept.
6. **Table over paragraph** when content has repeating structure.
7. **Every behavior claim is testable.** If you cannot describe the test, it is an opinion. Move it or delete it.
8. **No preamble.** Do not restate the heading in the first sentence.
9. **Diagrams are text** (Mermaid) so they version and diff.
10. **Code samples in docs are tested**, or marked `# illustrative, not tested`.

## Banned words in requirements

robust, seamless, intuitive, powerful, flexible, scalable, simple, easy, modern, best-in-class, leverage, utilize, etc., various, appropriate, sufficient, reasonable, as needed, seamlessly, effectively, properly, correctly, better, improved, optimized, comprehensive, holistic

Each is banned because it hides the number or the decision that actually matters.

## Quick self-check

- [ ] Read it aloud. Any sentence you stumble on gets rewritten.
- [ ] Search the banned list. Zero hits.
- [ ] Every adjective has a number beside it.
- [ ] Every "it", "this", "that" has one unambiguous referent.
- [ ] No sentence over 30 words.
- [ ] No unfilled `<placeholder>`.
