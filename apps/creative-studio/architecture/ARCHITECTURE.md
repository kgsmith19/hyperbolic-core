# Architecture

## Boundaries
- `standards/`: normative creative and quality rules.
- `registry/`: structured, source-linked inventories of tools, concepts, visual vocabulary and evaluations.
- `research/`: questions, comparisons, evidence and decisions.
- `experiments/`: isolated proofs of concept; each has a brief, hypotheses, measurements and verdict.
- `recipes/` (future): tested, reusable effects with examples and accessibility fallbacks.
- `showcase/` (future): curated completed artifacts, not every experiment.
- `assets/` (future): original or licensed assets with provenance; no unlicensed fonts.
- `scripts/` and `.github/`: deterministic validation and automation.

## Design decisions
1. Markdown is human-readable policy; JSON is machine-readable registry data.
2. Each tool has an ID, source URL, category, purpose, status, license-check state, and trade-offs.
3. Prefer native HTML/CSS/SVG before introducing heavy libraries.
4. Use GSAP for complex cinematic timelines, Motion for React interactions, D3 for data-driven SVG; add Theatre.js, Lenis, Rive or Three.js only when experiments justify them.
5. Keep each experiment independently runnable and documented. Avoid a giant all-purpose dependency bundle.
6. Record licenses and versions at adoption time; never assume a library's terms are unchanged.
7. Protect personal content: the repository must be private before personal materials are committed.

## Roadmap
Phase 0 standards/registry → Phase 1 scroll prototype → Phase 2 reusable recipes → Phase 3 searchable gallery and starter templates.
