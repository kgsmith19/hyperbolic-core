# Working in creative-studio

Creative Studio is a personal studio for editorial visual explanations, diagrams, presentations and
scrollytelling. It is a documentation and research repository today: there is no application code,
and the one executable is the registry validator.

## Sources of truth

| What | Where |
| --- | --- |
| Creative and quality rules | `standards/CREATIVE_STANDARD.md` |
| Structure and boundaries | `architecture/ARCHITECTURE.md` |
| Tool, concept and vocabulary data | `registry/*.json` (validated by `scripts/validate.py`) |
| Research and decisions | `research/` |

## Commands

```sh
python3 scripts/validate.py   # registry validation; the lane's only check
```

## Rules

- **Validate before you commit.** Any change under `registry/` must pass `scripts/validate.py`.
- **Registry is data, the standard is policy.** Markdown holds rules; JSON holds structured inventories.
- **Each tool records its license check.** A new tool entry carries a license-check state and a source
  URL; an unverified license is recorded as unverified, never assumed.
- **No personal or confidential material.** This repository was public at setup. Do not add private
  material until its visibility is changed to private (see the README's Privacy section).
- **Assets need provenance.** Use original or appropriately licensed assets, and record the licence.
