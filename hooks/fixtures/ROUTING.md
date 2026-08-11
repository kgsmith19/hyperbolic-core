# ROUTING.md — CI test fixture, NOT the real routing table

This file exists only so `hooks/route.test.mjs` has a table to score against on
CI (the real table lives one directory above the repo — see `hooks/route.mjs`'s
`TABLE` resolution — and is never checked in). Every path/label/signal below is
derived directly from `hooks/route.test.mjs`'s assertions.

```json
{
  "routes": [
    { "path": "C:\\code", "label": "root", "signals": ["across all repos"] },
    { "path": "C:\\code\\guards", "label": "acc", "signals": ["budget hook", "command center", "guards hook"] },
    { "path": "C:\\code\\lifeos-ecosystem\\lifeos", "label": "lifeos", "signals": ["api contract", "types\\.gen\\.ts"] },
    { "path": "C:\\code\\lifeos-ecosystem\\lifeos\\backend", "label": "lifeos-backend", "signals": ["supabase", "pytest", "fastapi"] },
    { "path": "C:\\code\\lifeos-ecosystem\\lifeos\\frontend", "label": "lifeos-frontend", "signals": ["react", "tailwind", "playwright"] }
  ]
}
```
