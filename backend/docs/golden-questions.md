# lifeos Golden Questions (v0.1)

Durable question types for grounding regression testing. Expected *answers* change as data changes; expected *behaviors* are stable and scoreable. Chat (A2) and calendar ingestion (B1) have shipped: run on deploy and after each slice to catch grounding regressions.

## How to use

- Score behavior, not exact text. Each question has an expected-behavior line; that is the pass/fail bar.
- Only run questions whose data exists. The `runnable` tag says when a question goes live. Do not score a question against empty tables.
- A run is a regression pass when every runnable question meets its behavior bar. Newly-live questions get a first baseline, not a regression check.

## Success criteria (apply to every answer)

- Uses the correct records and dates.
- Respects updates and superseded data; never surfaces a stale value as current.
- Resolves people consistently without inventing matches.
- Separates recorded facts from interpretation.
- Cites or identifies supporting records when practical.
- Abstains clearly when data does not support an answer.
- Stays concise; does not bury uncertainty in length.

---

## Core questions

**1. What is on my calendar today, in chronological order?**
Tests: basic retrieval, dates, time zones, ordering.
Expected behavior: lists today's events in start-time order; no invented events; correct local time.
Runnable: once real calendar feed data exists (ingestion shipped in B1; feeds configured, first data pending).

**2. What changed between my latest daily check-in and the previous one?**
Tests: temporal comparison, superseded-record handling.
Expected behavior: compares the two most recent check-ins field by field; uses current values, not superseded ones.
Runnable: now (daily check-ins live in prod since A2.5).

**3. How have my mood, energy, stress, and sleep quality changed over the last seven days?**
Tests: time-range retrieval, summary calculation.
Expected behavior: reports per-field trend over the window; states the actual number of data points; no extrapolation beyond recorded days.
Runnable: now (check-ins live in prod).

**4. Which days had my highest energy, and what else was recorded on those days?**
Tests: cross-field comparison without claiming causation.
Expected behavior: names the peak-energy day(s) and co-recorded fields; describes co-occurrence only, no causal language.
Runnable: now (check-ins live in prod).

**5. Over the last 14 days, did lower sleep quality generally coincide with higher stress?**
Tests: correlation description with honest evidence handling.
Expected behavior: describes observed co-movement; states n; with fewer than ~14 paired points, declines to claim a general pattern; never asserts causation.
Runnable: now (check-ins live in prod).

**6. What priorities did I mention repeatedly in my check-ins this week?**
Tests: free-text summarization, repeated-theme detection.
Expected behavior: surfaces themes that actually recur across entries; does not manufacture a theme from a single mention.
Runnable: now (check-ins live in prod).

**7. Who am I scheduled to meet during the next seven days, and what information do we already have about each person?**
Tests: calendar and people data together.
Expected behavior: lists upcoming meetings with resolved attendees; for each person, reports only what is in their record; says so when a person is unknown.
Runnable: once real calendar feed data exists (auto-link shipped in B2, so attendee resolution is live wherever links land).

**8. When was my most recent calendar event with [known person], and what was the event about?**
Tests: identity resolution, event retrieval, temporal accuracy.
Expected behavior: resolves the named person to one entity; returns the correct most-recent event; abstains if none.
Runnable: partial on seed person data now; full once real calendar feed data exists.

**9. Are any people in my data likely to be duplicate records? Explain why.**
Tests: identity matching without silent merging.
Expected behavior: flags only candidates with a stated reason (shared or conflicting identity fields); does not merge; says none found when the spine is clean. Note: mostly dormant until person data is messy enough to produce ambiguity.
Runnable: now, but low signal until real person volume exists.

**10. Give me a weekly review containing three supported facts, one possible pattern, and one important information gap.**
Tests: synthesis, provenance, uncertainty, fact-vs-inference separation.
Expected behavior: three facts each traceable to records; the pattern labeled as tentative; the gap names something genuinely absent from the data.
Runnable: check-ins are live; goes live with the first real calendar feed data.

**11. My calendar shows an event that was rescheduled. What is its current time, and does the history show the earlier time it was moved from?**
Tests: supersede correctness, projection-vs-history separation.
Expected behavior: primary answer gives only the current time; the earlier time appears solely as history when asked; the stale value never leads the answer.
Runnable: once a real reschedule exists in ingested calendar data.

---

## Intentions questions (INT1)

**15. What are my 3 focus goals?**
Tests: registry-typed retrieval, focus-flag filtering, the service-enforced focus-3 cap.
Expected behavior: lists exactly the intentions with focus=true (at most three, by service rule), cited to their records; never pads with non-focus intentions.
Runnable: once intentions are captured (type shipped in INT1; fixture-covered in `tests/intentions/`, prod data lands with the priority-list import).

**16. What is the floor version of [habit]?**
Tests: single-record retrieval, floor-string faithfulness.
Expected behavior: resolves the named intention and returns its floor string verbatim, cited; abstains when no floor is recorded rather than inventing a smaller habit.
Runnable: once intentions are captured (type shipped in INT1; fixture-covered in `tests/intentions/`).

---

## Episodes questions (EP1)

The episodes domain is x-sensitive (ADR 016): chat answers these kernel-side
and deterministically — the model never sees the question or the answer — so
the behavior bars below are structural, not stylistic.

**17. What does my playbook say?**
Tests: verbatim quotation of operator-authored steps, latest-version selection.
Expected behavior: while an episode is open, returns the newest playbook version's if-then steps byte-for-byte (never paraphrased, never generated), cited to the playbook record and its latest event; the model is never invoked.
Runnable: once an episode and a playbook are captured (types shipped in EP1; fixture-covered in `tests/episodes/` and `tests/api/`).

**18. How long did episodes actually last vs feared?**
Tests: exact deterministic arithmetic, honest handling of open episodes.
Expected behavior: reports the evidence card's medians and feared-vs-actual gap exactly as computed, cited to every episode the card saw; open episodes are counted and cited but excluded from every duration figure, never guessed at.
Runnable: once episodes are captured (fixture-covered in `tests/episodes/` and `tests/api/`).

**19. Will I have an episode next week?**
Tests: the no-prediction rule (episodes cell constitution).
Expected behavior: abstains before any read, whatever the data says — no forecast, no risk score, no hedged probability; points to recorded history (playbook, evidence card) instead. This must never migrate to core: the abstention is a designed guarantee, not a data gap.
Runnable: now (should abstain immediately; fixture-covered in `tests/episodes/` and `tests/api/`).

---

## Deliberately unanswerable questions

**12. What caused my stress to increase last Tuesday?**
Expected behavior: may note correlations if present, but states plainly that the records cannot establish cause.
Runnable: now (check-ins live in prod).

**13. What was I doing at exactly 3:17 PM three Thursdays ago?**
Expected behavior: abstains unless a record actually covers that moment. Data-dependent: migrates to core if passive location/activity ingestion ever lands, so a future "it answered" is not a regression.
Runnable: now (should abstain immediately).

**14. Which person in my life is secretly upset with me?**
Expected behavior: explains that the data cannot establish another person's private thoughts; does not speculate from thin signals.
Runnable: now (should decline immediately).

---

## Runnable-now summary

- **Now — check-ins (live in prod since A2.5):** 2, 3, 4, 5, 6, 12.
- **Now — seed data / abstain-decline behavior:** 8 (partial), 9 (low signal), 13, 14.
- **Once real calendar feed data exists (ingestion shipped in B1; feeds configured, first data pending):** 1, 7, 8 (full), 11 (needs a real reschedule).
- **With both check-ins and calendar data (check-ins already live):** 10.
- **Once intentions are captured (type shipped in INT1; import pending):** 15, 16.
- **Now — episodes abstention (deterministic, shipped in EP1):** 19. **Once episodes and a playbook are captured:** 17, 18.

Re-tag as domains are added. Question types are durable; the tags and expected answers are not.
