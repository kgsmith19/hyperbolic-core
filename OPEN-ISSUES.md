# Open issues — lifeos-ui

Standing ledger of things raised and not fixed. Entry format and the
resolution rule live in `C:\code\OPEN-ISSUES.md`. `/resolve-issues` works this
list to zero.

---

## Open

_(none)_

## Resolved

- 2026-07-30 — OI-001 cockpit `episodes_line` — FIXED. `Episodes` section in
  `BriefingSections.tsx`, rendered between Appointments and the Monday gate
  (the composition order `domains/ops/briefing.py` writes), absent entirely
  when the job wrote no line. Two tests in `Tomorrow.test.tsx`.
- 2026-07-30 — OI-002 bundle chunk warning — FIXED. Route-level `lazy()` for
  the five authenticated pages; Login stays eager as the only first-paint
  page. One 493kB chunk became a 240kB entry + 236kB supabase client + five
  route chunks under 8kB. No new dependency.
