# Open issues — lifeos-ui

Standing ledger of things raised and not fixed. Entry format and the
resolution rule live in `C:\code\OPEN-ISSUES.md`. `/resolve-issues` works this
list to zero.

---

## Open

## OI-001 Tomorrow cockpit drops the briefing `episodes_line`
- opened: 2026-07-30
- where: Tomorrow cockpit view
- what: the cockpit renders enumerated sections only, so the stored briefing's
  `episodes_line` never reaches the screen
- why open: judged in-contract and deferred to "a future lifeos-ui touch"
- done when: `episodes_line` renders as its own section when present, absent
  cleanly when not, with a test covering both

## OI-002 Bundle chunk warning at ~494kB
- opened: 2026-07-30
- where: Vite build output
- what: the main chunk trips the size warning
- why open: deferred with "split when it grows again"
- done when: the build emits no chunk-size warning and the app still loads
  clean

## Resolved

_(none yet)_
