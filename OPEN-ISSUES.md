# Open issues — lifeos-ui

Historical ledger of things raised and fixed before this repo adopted GitHub
Issues as the durable work-item source (2026-08-08 migration). New work is a
GitHub Issue (`.github/ISSUE_TEMPLATE/work-item.md`), not an entry here. Kept
for the record below; `/resolve-issues` no longer has anything to work.

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
