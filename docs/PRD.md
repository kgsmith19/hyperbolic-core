---
title: Prompt Organizer Product Requirements Document
status: draft
created: 2026-08-06
updated: 2026-08-08
owner: Kyle
version: 0.1.9
---

# Prompt Organizer PRD

> Written using `templates/PRD-TEMPLATE.md`. This is the first real use of the pack, which is deliberate: if the template does not survive its own first product, it needs fixing before anything else uses it.

---

## 1. What this is

This is a place to keep the instructions you write for AI tools, so you can find them again and reuse them instead of retyping them. You save an instruction once, mark the parts that change (like a project name), and later pick the instruction, fill in those parts, and copy the finished text. You can also save a short version and a long version of the same instruction and choose which one you want.

## 2. Problem

| Field | Answer |
|---|---|
| Who has the problem | Kyle, working daily with coding agents and LLM tools |
| What they do today | Retypes long instructions from scratch, or hunts through old chat transcripts and files to find one written before |
| What it costs them | Self-reported as the single largest recurring time cost in the workflow. Measure it in the first week: minutes per day spent typing or hunting for prompt text. |
| Why solve it now | The pack in `prompts/` creates ten reusable prompts with variable blocks and optional sections. Managing those by hand in files is the exact problem this solves, so the tool has real content on day one. |
| What happens if we do nothing | Prompt text stays scattered across files, transcripts, and memory. Improvements to a prompt are lost because there is no single copy to improve. |

## 3. Users

| ID | User type | What they need to do | How often | Technical level |
|---|---|---|---|---|
| U-001 | Kyle (sole user) | Find a saved prompt, fill in its variables, copy the result | 5 to 30 times per day | Expert |
| U-002 | An agent acting for Kyle | Fetch a rendered prompt by name and configuration over an API | Unknown; assume 0 until measured | n/a |

## 4. Scope

### 4.1 In scope

- Save a prompt with a title, body, and tags
- Mark parts of the body as variables and fill them at use time
- Mark parts of the body as optional sections and include or exclude them at use time
- Save named configurations: a set of variable values plus a set of included sections
- Render a prompt with a configuration and copy the result
- Search prompts by title, tag, and body text
- Keep every version of a prompt body, never overwrite
- Count how often each prompt is used

### 4.2 Out of scope

| ID | Not doing | Why not | Revisit when |
|---|---|---|---|
| OOS-001 | Sharing or multi-user access | One user. Auth exists only to protect the data, not to collaborate. | Someone else asks to use it |
| OOS-002 | Running prompts against a model from inside the tool | Every client already does this better. Copying text out is sufficient and costs nothing to build. | Rendered output needs to be scored automatically (that is the Regression Tracker, a separate tool) |
| OOS-003 | Prompt quality scoring or suggestions | That is Instruction Optimizer, a separate idea that reads this tool's data | Instruction Optimizer is specced |
| OOS-004 | Folders or hierarchy | Tags plus search do the job at this scale. Hierarchy forces a decision on every save. | Over 300 prompts and search demonstrably fails |
| OOS-005 | A browser extension or desktop app | The web page plus copy-to-clipboard covers the workflow | Measured friction says otherwise |
| OOS-006 | Importing from chat history | A large parsing problem serving a one-time need | Never, most likely |
| OOS-007 | Rich text editing | Prompts are plain text. Formatting is noise. | Never |
| OOS-008 | Version diffing UI | Storing versions is cheap; rendering diffs is not, and git-style review is not the daily need | A version is actually needed for rollback and reading it raw is painful |

## 5. Use cases

### UC-001: Reuse a saved prompt

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | At least one prompt is saved |
| Trigger | Kyle needs to instruct an agent |
| Main path | 1. Opens the tool. 2. Types part of the title or a tag into search. 3. Selects a prompt. 4. Picks a saved configuration, or fills variables directly. 5. Presses copy. 6. Pastes into the agent. |
| Success outcome | The full rendered prompt text is on the clipboard, with every variable substituted and every excluded section removed |
| Failure paths | No prompt matches the search -> the empty state names what was searched and offers to create a prompt with that title. A required variable is empty -> copy is blocked and the empty variable is named. |
| Frequency | 5 to 30 per day |
| Traces to | FR-001, FR-004, FR-006, FR-007 |

### UC-002: Save a new prompt

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | None |
| Trigger | Kyle has written an instruction worth keeping |
| Main path | 1. Presses new. 2. Enters a title and pastes the body. 3. Adds tags. 4. Saves. |
| Success outcome | The prompt appears in the list and is findable by title, tag, and body text |
| Failure paths | Title is empty -> save is blocked with the reason. Title already exists -> save is blocked, naming the existing prompt. |
| Frequency | 1 to 5 per day |
| Traces to | FR-001, FR-002, FR-006 |

### UC-003: Keep a lean and a full version of one prompt

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | A prompt exists containing optional sections |
| Trigger | Kyle wants the short form for a quick task |
| Main path | 1. Opens the prompt. 2. Selects the `lean` configuration. 3. Copies. |
| Success outcome | The copied text excludes every optional section not listed in that configuration |
| Failure paths | The configuration references a section that no longer exists in the body -> the tool shows which one and renders the rest |
| Frequency | Several times per day |
| Traces to | FR-005, FR-007, FR-008 |

### UC-004: Improve a prompt without losing the old one

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | A prompt exists |
| Trigger | The prompt produced a bad result and needs an edit |
| Main path | 1. Opens the prompt. 2. Edits the body. 3. Saves. 4. A new version is created; the previous version remains readable. |
| Success outcome | The current version is the edit; every prior version is retrievable |
| Failure paths | None expected |
| Frequency | 1 to 10 per day |
| Traces to | FR-003, FR-009 |

### UC-005: Retire a prompt without losing it

| Field | Content |
|---|---|
| Actor | U-001 |
| Precondition | An active prompt exists |
| Trigger | The prompt is no longer useful but Kyle doesn't want to risk losing it for good |
| Main path | 1. Opens the prompt. 2. Presses Archive. 3. It disappears from the default list. |
| Success outcome | The prompt and every version stay in the database, readable via "Show archived," and can be restored to active at any time |
| Failure paths | None expected — archiving is reversible and never touches stored data |
| Frequency | Rare |
| Traces to | FR-014 |

## 6. Functional requirements

| ID | Requirement | Priority | Acceptance criterion (objective) | Traces to | Status |
|---|---|---|---|---|---|
| FR-001 | The system must save a prompt with a title of 1 to 200 characters and a body of 1 to 100,000 characters. | Must | Given an empty library, when a prompt titled `Spec Author` with a 500-character body is saved, then it appears in the list and its body is returned unchanged, character for character. | UC-002 | done |
| FR-002 | The system must reject a prompt whose title duplicates an existing prompt's title, case-insensitively. | Must | Given a prompt titled `Spec Author` exists, when saving another titled `spec author`, then the save is rejected with `409` and Postgres code `23505`. (Corrected 2026-08-07, SL-004: PostgREST/Postgres suppresses the constraint-violation `details` field for a non-superuser role, confirmed live — a message naming the specific existing prompt is not a guarantee this system can make to an `authenticated` caller. `code` is the reliable signal; see SPEC-0002 AC-001.) | UC-002 | done |
| FR-003 | The system must create a new version on every body change and must never modify a stored version. | Must | Given a prompt at version 1, when the body is changed and saved, then version 2 holds the new body, version 1 holds the original unchanged, and the prompt reports current version 2. | UC-004 | done |
| FR-004 | The system must substitute every `{{VARIABLE}}` token in the body with the value supplied for that name. | Must | Given a body `Repo is {{REPO}}.` and the value `REPO=toolbelt`, when rendered, then the output is exactly `Repo is toolbelt.` | UC-001 | done |
| FR-005 | The system must remove any block fenced by `<!--OPTIONAL:id-->` and `<!--/OPTIONAL:id-->` whose `id` is not in the requested include list, and must keep blocks whose `id` is in the list, with the fence comments removed in both cases. A *block* is a well-formed pair: the closing fence's `id` must match the opening fence's, and an `id` must be at least one character of `[A-Za-z0-9_-]`. Anything else (a lone opening fence, mismatched ids, an empty id) is literal text, not a section. (Clarified 2026-08-07, SL-003: the pairing rule was implicit in the original wording, and it is what preserves SL-002's PROP-005 byte-for-byte guarantee for fence-shaped text; see SPEC-0006 AC-004.) | Must | Given a body with sections `a` and `b`, when rendered including only `a`, then the output contains section `a`'s content, does not contain section `b`'s content, and contains no `<!--OPTIONAL` text. | UC-003 | done |
| FR-006 | The system must return prompts matching a search string against title, tags, and body, ranked title matches first. | Must | Given three prompts, when searching `spec`, then only prompts containing `spec` in title, a tag, or body are returned, and a title match sorts above a body-only match. | UC-001, UC-002 | done |
| FR-007 | The system must render a prompt to plain text and place it on the clipboard in one user action. | Must | Given a prompt with all variables filled, when the copy control is activated, then the clipboard contains the fully rendered text and the interface confirms the copy within 1 second. | UC-001 | done |
| FR-008 | The system must save a named configuration consisting of variable values and a list of included section ids, and must apply it on selection. | Must | Given a configuration `lean` with `REPO=toolbelt` and sections `[a]`, when `lean` is selected, then the variable field for `REPO` reads `toolbelt` and only section `a` is included. | UC-003 | not-started |
| FR-009 | The system must display every prior version of a prompt with its creation timestamp, and must allow restoring one as a new current version. | Should | Given a prompt at version 3, when version 1 is restored, then version 4 is created holding version 1's body and version 1 remains unchanged. | UC-004 | done |
| FR-010 | The system must block rendering when a variable present in the body has no value, and must name every such variable. | Must | Given a body containing `{{A}}` and `{{B}}` with only `A` supplied, when render is attempted, then it is rejected and the message names `B`. | UC-001 | done |
| FR-011 | The system must record a usage row each time a prompt is rendered and copied, with the prompt id, version, configuration used, and timestamp. | Should | Given a prompt is copied twice, when its usage count is read, then it is 2 and two rows exist with distinct timestamps. | UC-001 | done |
| FR-012 | The system must assign zero or more tags to a prompt and must filter the list by a selected tag. | Should | Given prompts tagged `sdd` and `review`, when filtering by `sdd`, then only prompts carrying that tag are returned. | UC-001 | done |
| FR-013 | The system must serve a rendered prompt over an authenticated HTTP endpoint given a prompt name and a configuration name. | Could | Given `GET /v1/render?name=spec-author&config=lean` with a valid key, then the response body is the rendered text with content type `text/plain` and status `200`. | U-002 | not-started |
| FR-014 | The system must let an active prompt be archived (`is_active` set false) and an archived prompt reactivated, without deleting the row or any version, and the default list and search must exclude archived prompts. | Must | Given an active prompt, when it is archived, then it no longer appears in the default (active-only) view, its row and every version are unchanged when read directly, and reactivating it makes it appear in the default view again. | UC-005 | done |

## 7. Non-functional requirements

| ID | Category | Requirement | Threshold | How it is measured | Status |
|---|---|---|---|---|---|
| NFR-001 | Performance | Search must return results within 300 ms at p95 with 1,000 prompts stored. | 300 ms | Timed query against a seeded database | not-started |
| NFR-002 | Performance | Render must complete within 100 ms at p95 for a 100,000-character body — **any** such body, including one that is pathological rather than typical. | 100 ms | Timed unit benchmark (`tests/performance.test.mjs`, T-U-024..026): a realistic body and a worst-case body against the absolute threshold, plus a machine-independent growth-ratio check, since an absolute threshold alone passes on fast hardware even when the algorithm is quadratic. | done |
| NFR-003 | Security | Every read and write must be rejected unless the caller is the authenticated owner of the row. | 100% of cross-user attempts rejected | RLS policy test as a second user | done |
| NFR-004 | Security | No API key or service-role credential may appear in client-delivered code. | 0 occurrences | Grep of the built bundle in CI | not-started |
| NFR-005 | Durability | A saved prompt version must never be modified or deleted by the application. | 0 update or delete statements against the version table | Code inspection plus a revoked `UPDATE`/`DELETE` grant on the table | done |
| NFR-006 | Availability | The tool must be usable whenever the database is reachable. No additional service may be required to render. | Rendering has zero external dependencies | Inspection: render is a pure function | not-started |
| NFR-007 | Cost | Infrastructure cost must be $0 above the existing `toolbelt` project. | $0 marginal | Billing report | done |
| NFR-008 | Accessibility | Every control must be reachable and operable by keyboard alone, and search must be focusable by a single keystroke from anywhere in the app. | 0 keyboard traps | Manual keyboard pass plus an automated scan | not-started |
| NFR-009 | Maintainability | No source file over 250 lines; no function over 40 lines. | 250 / 40 | Line count (no linter exists yet; adding one is a 0-library-budget decision) | done |
| NFR-010 | Observability | Every render must write one `core.run` row and one `core.cost` row with wall-clock time. | 100% of renders | Row count versus usage count | **blocked, not merely not-started (2026-08-07):** as worded this requires writing into `toolbelt`'s `core` schema, which this repo's own `CLAUDE.md` forbids ("Never write to any schema except `prompt`"). SPEC-0008 delivered FR-011 (a `prompt.usage` row per copy) without resolving this; the mechanism is a real architecture decision — an RPC `toolbelt` exposes and this repo calls, `toolbelt` deriving `core.run`/`core.cost` from `prompt.usage` itself, or rewording this NFR to name `prompt.usage` instead — none of which this repo can pick unilaterally. See SPEC-0008 section 2.1. |
| NFR-011 | Privacy | Prompt bodies must never be sent to any third party by this application. | 0 outbound calls carrying body text | Inspection of every network call | not-started |

Categories considered and not applicable: internationalization (single user, English); scalability beyond one user; compliance (no regulated data); portability (web only, by choice).

## 8. Data requirements

| ID | Data item | Meaning in plain language | Source | Classification | Retention | Traces to |
|---|---|---|---|---|---|---|
| DR-001 | Prompt title | The short name you search for | User typed | internal | Forever, until the user deletes the prompt | FR-001 |
| DR-002 | Prompt body | The full instruction text | User typed or pasted | confidential (may contain business context and system details) | Every version kept forever | FR-001, FR-003 |
| DR-003 | Variable name and value | The name of a fill-in and what was filled in | User typed | confidential (values may name real systems) | Kept with its configuration | FR-004, FR-008 |
| DR-004 | Section id | The name of an optional block | Parsed from the body | internal | Derived, not stored independently | FR-005 |
| DR-005 | Usage record | When a prompt was copied and which configuration was used | Generated | internal | 365 days, then aggregated to a monthly count | FR-011 |
| DR-006 | Owner id | Which account owns the row | Auth | internal | Life of the row | NFR-003 |
| DR-007 | Active flag | Whether a prompt is archived or in active use | User action | internal | Life of the row | FR-014 |

DR-002 and DR-003 are classified confidential, so NFR-003, NFR-004, and NFR-011 exist to protect them.

## 9. Constraints

| ID | Constraint | Type | Source | Consequence |
|---|---|---|---|---|
| CON-001 | Lives in the existing `toolbelt` Supabase project, schema `prompt`. | technical | `SUPABASE-PROJECT-TOPOLOGY.md` | No new project, no new database cost |
| CON-002 | Sole user for the foreseeable future. | business | Owner | No collaboration features, no invitations, no roles |
| CON-003 | Must be built through the slice workflow in `prompts/`, under the kernel budgets. | process | Owner | No slice over 300 net source LOC |
| CON-004 | Variable and section syntax must match the pack exactly: `{{VAR}}` and `<!--OPTIONAL:id-->`. | technical | `kernel/PROMPT-KERNEL.md` section 1 | The pack's own files are valid input on day one |

## 10. Assumptions

| ID | Assumption | How to verify | Cost if wrong | Status |
|---|---|---|---|---|
| ASM-001 | Search plus tags is sufficient organization up to roughly 300 prompts. | Count prompts monthly; log searches returning nothing useful | Adding hierarchy later is a two-slice change, not a rewrite | unverified |
| ASM-002 | Copy-to-clipboard is the whole integration need; no extension or API is required at first. | Track how often the flow ends in a paste versus a wish for direct invocation | FR-013 moves from Could to Must; one slice | unverified |
| ASM-003 | Prompt bodies stay under 100,000 characters. | Track the maximum stored | Storage still works. Render no longer degrades: SL-010 replaced the quadratic section parser with a linear one, so this assumption is no longer load-bearing for NFR-002 (measured 2026-08-07: worst case at the ceiling fell from 164.8 ms to 0.98 ms, and growth is now linear rather than quadratic). | unverified, but no longer NFR-002's guard |
| ASM-004 | Nested optional sections are not needed. | Watch whether any real prompt wants them | Parser complexity roughly doubles; a full slice | unverified |
| ASM-005 | Variables are plain string substitution; no defaults, conditionals, or loops are needed. | Watch for the first prompt that wants one | A template engine is a dependency decision, which is a halt | unverified |

ASM-005 is the one worth watching. The moment a prompt wants `{{VAR|default}}`, this becomes a templating language, and templating languages grow without limit. If that pressure appears, the correct answer is usually another saved configuration rather than more syntax.

## 11. External interfaces

None. The tool reads and writes its own schema and nothing else. Adding one requires a PRD change and explicit approval per kernel halt condition H6.

## 12. Success metrics

| ID | Metric | Definition (exact formula) | Baseline today | Target | Measured by | Review cadence |
|---|---|---|---|---|---|---|
| MET-001 | Reuse rate | (renders in the period) / (prompts created in the period) | 0 | Above 5.0 by day 30 | Query on `prompt.usage` | Weekly |
| MET-002 | Retype avoidance | (renders in the period) x (median body length in characters) | 0 | Above 200,000 characters in week 4 | Query | Weekly |
| MET-003 | Time to prompt | Seconds from opening the tool to clipboard containing rendered text, p50 | Unknown | Under 15 s | Timestamps between page load and the usage row | Weekly |
| MET-004 | Dead prompts | Count of prompts with zero renders in 60 days | 0 | Under 20% of the library | Query | Monthly |

**Gaming risk, per metric:**

- MET-001 is gamed by creating fewer prompts, which is the opposite of the goal. Read it alongside MET-004.
- MET-002 is gamed by writing longer prompts. It measures characters moved, not value; treat it as a proxy and say so.
- MET-003 is gamed by keeping one prompt permanently open. Measure from page load, not from focus.
- MET-004 is the honest one: a library full of prompts nobody uses is a failure regardless of what the other three say.

## 13. Slice plan

| Slice | Name | What becomes true | Requirements delivered | Est. net LOC | Depends on |
|---|---|---|---|---|---|
| SL-000 | Walking skeleton | One prompt can be saved with a title and body, and read back on a page. One table, one endpoint, one screen, one rule (out-of-bounds title or body is rejected). | FR-001 | 150 | `core` spine exists |
| SL-001 | List and search | Every saved prompt is listed and findable by a search string across title and body. | FR-006 (partial: no tags) | 200 | SL-000 |
| SL-002 | Variables and render | A body's `{{VAR}}` tokens are detected, prompted for, substituted, and the result is copyable. | FR-004, FR-007, FR-010 | 280 | SL-001 |
| SL-003 | Optional sections | `<!--OPTIONAL:id-->` blocks are detected and included or excluded at render. | FR-005 | 220 | SL-002 |
| SL-004 | Versions | Every save creates a version; prior versions are readable. | FR-003, FR-002 | 250 | SL-000 |
| SL-005 | Configurations | Named sets of variable values plus included sections are saved and applied. | FR-008 | 280 | SL-003, SL-004 |
| SL-006 | Tags | Prompts carry tags; the list filters by tag; search includes tags. | FR-012, FR-006 (complete) | 200 | SL-001 |
| SL-007 | Usage tracking | Every copy writes a usage row; counts are visible. | FR-011 (NFR-010 blocked, see its row above) | 180 (shipped 2026-08-07, SPEC-0008, FR-011 only) | SL-002 |
| SL-008 | Version restore | A prior version can be restored as a new current version. | FR-009 | 150 | SL-004 |
| SL-009 | Render endpoint | An authenticated HTTP endpoint returns rendered text by name and configuration. | FR-013 | 200 | SL-005 |
| SL-011 | Archive prompt | A prompt can be archived (hidden, never deleted) and reactivated; this is the delete half of CRUD. | FR-014 | 60 (shipped 2026-08-08, SPEC-0009) | SL-000 |

**The first useful day is the end of SL-002.** At that point the tool already beats retyping, and the pack's own ten prompts can be loaded into it. Everything after SL-002 is improvement on a thing already earning its keep, which is exactly the shape a slice plan should have.

## 14. Glossary

| Term | Definition (plain language) | Not to be confused with |
|---|---|---|
| Prompt | A saved block of instruction text with a title | Configuration, which is a set of choices about how to render a prompt |
| Body | The full text of a prompt, including variable tokens and section fences | Rendered text, which is the body after substitution and section removal |
| Variable | A named fill-in, written `{{NAME}}` in the body | Configuration, which supplies values for variables |
| Section | An optional block fenced by `<!--OPTIONAL:id-->` | Version, which is a snapshot of the whole body |
| Configuration | A saved, named set of variable values plus the list of section ids to include | Version |
| Version | An immutable snapshot of a body, created on every change | Configuration |
| Render | Producing the final text from a body plus a configuration | Copy, which places rendered text on the clipboard |
| Usage | One record of a render that was copied | Render, which can happen without a copy (preview) |

## 15. Open questions

| ID | Question | Blocks | Owner | Needed by | Answer |
|---|---|---|---|---|---|
| Q-001 | Should a configuration belong to one prompt, or be shareable across prompts that use the same variable names? | SL-005 | Kyle | before SL-005 | Default: belongs to one prompt. Sharing is speculative generality until a second prompt actually wants it. |
| Q-002 | Does a preview that is not copied count as a usage? | SL-007, MET-001 | Kyle | before SL-007 | Default: no. Only copies count, so the metric tracks intent to use. |
| Q-003 | Should the ten pack prompts be seeded automatically or pasted in by hand? | after SL-002 | Kyle | before SL-003 | Default: by hand. Ten pastes is ten minutes; a seeding mechanism is a slice. |
| Q-004 | Is full-text search sufficient, or is semantic search needed to find a prompt by what it does rather than what it says? | SL-001, ASM-001 | Kyle | when search first fails | Default: full text. Semantic search adds an embedding pipeline and a dependency, which is a halt-level decision. |

## 16. Change log

| Date | Version | Change | Reason | Affected IDs |
|---|---|---|---|---|
| 2026-08-06 | 0.1.0 | Initial draft. | First application of the PRD template. | - |
| 2026-08-08 | 0.1.9 | SL-011 shipped (SPEC-0009): a single `is_active` boolean is the delete half of CRUD — archiving hides a prompt from the default list without ever running `DELETE` or touching version history. FR-014 (new) → `done`; UC-005, DR-007 added; slice plan gained SL-011. | Asked directly for CRUD delete; a real `DELETE` would cascade through `prompt_version` and contradict DR-002 ("every version kept forever") and NFR-005, so soft delete via a flag was the only option consistent with this PRD's own durability requirements — confirmed with Kyle before touching the live schema. | FR-014, UC-005, DR-007, SL-011 |
| 2026-08-07 | 0.1.8 | SL-007 shipped (SPEC-0008). FR-011 → `done`. NFR-010 reclassified from `not-started` to `blocked`: as worded it requires writing into `toolbelt`'s `core` schema, which this repo's own `CLAUDE.md` forbids. Not a new decision — a standing contradiction this slice's scoping exposed, not resolved. `docs/SYSTEM-REQUIREMENTS.md` SR-04 corrected (it claimed "reads of `core` begin in SL-007"; this slice reads nothing from `core` either). | Kyle's PRD self-check line 12 ("no two requirements contradict") no longer holds for NFR-010 against `CLAUDE.md`'s explicit "Never" rule, so it needed a status that says so rather than `not-started`, which reads as merely unscheduled. FR-011 is real and independently valuable: a `prompt.usage` row per copy, composite-FK'd to `prompt_version` so it can never name a version that never existed. Building it surfaced a second, unrelated defect: 21 pre-SL-004 fixture prompts had zero `prompt_version` rows (the versioning trigger didn't exist when they were created), which would have crashed the client's new version-lookup query and made those specific prompts un-loggable. Backfilled in the same migration, same "make the invariant actually true" precedent SPEC-0002's duplicate-title dedup already set. | FR-011, NFR-010, SL-007 |
| 2026-08-07 | 0.1.1 | SL-000 slice row now delivers FR-001 (was "none"); FR-001, NFR-003, NFR-007, NFR-009 set to `done`; NFR-009's measurement corrected from "lint rule" to line count. | The skeleton as built satisfies FR-001's acceptance criterion in full, and hiding that behind "none" would make the status columns dishonest once GATE-GREEN passed — the same recorded deviation the toolbelt PRD made for its Phase 0. NFR-003/NFR-007/NFR-009 hold for everything that exists after SL-000. No linter can exist under `MAX_NEW_LIBRARIES: 0`, so the measurement column now says what is actually done. | FR-001, NFR-003, NFR-007, NFR-009, SL-000 |
| 2026-08-07 | 0.1.2 | SL-001 and SL-004 shipped (worktree-parallel, `rules/07-SKILLS.md`). FR-006 → `in-slice-006` (title+body done, tags remain); FR-002, FR-003, NFR-005 → `done`. FR-002's AC corrected: the response's `message` names the violated constraint, not the conflicting prompt's value — Postgres suppresses the `details` field for a non-superuser role on a constraint violation, confirmed live against the real project. | The original FR-002 AC claimed a guarantee this system cannot make to an `authenticated` caller; SPEC-0002's own AC-001 carried the identical error and both were fixed together, spec-first, so the PRD and the spec never disagree on what is actually true. | FR-002, FR-003, FR-006, NFR-005, SL-001, SL-004 |
| 2026-08-07 | 0.1.4 | SL-006 shipped (serialized after SL-002, same `web/index.html`-overlap reasoning as 0.1.3). FR-012 → `done`; FR-006 → `done` in full (title, body, and tags). | Tag entry, chips, filter/clear, and tag-inclusive search all verified live in a browser against the real project. | FR-006, FR-012, SL-006 |
| 2026-08-07 | 0.1.5 | SL-008 shipped (serialized, same reasoning). FR-009 → `done`. SPEC-0005's own AC-003 corrected: its Given described a state impossible under SL-004's distinct-body guard (found implementing the test, not by inspection alone). | Version history, restore, and the guard's exact no-op boundary all verified live. `web/index.html` is now at its 250-line ceiling exactly — flagged for the next slice that needs to extend it. | FR-009, SL-008 |
| 2026-08-07 | 0.1.6 | SL-003 shipped. FR-005 → `done`, and its wording clarified to state the pairing rule (matching ids, non-empty id charset) that was previously implicit. `web/index.html`'s 250/250 ceiling — flagged in 0.1.5 — resolved by extracting `buildRenderPanel` to a new `web/panel.mjs`; the file is now 207 lines. | The clarification is not a scope change: a lone `<!--OPTIONAL:x-->` with no closer had to stay literal text regardless, because SL-002's PROP-005 (and T-U-011, whose deletion criterion reads "Never") guarantees fence-shaped text passes through byte-for-byte. Writing the rule down makes the parser's backreference a stated requirement rather than an implementation detail. Section inclusion, exclusion, fence stripping, and the FR-005 × FR-010 interaction (a variable inside an excluded section is never demanded) all verified live in a browser. SL-005's dependency on SL-003 is now unblocked. | FR-005, NFR-009, SL-003 |
| 2026-08-07 | 0.1.7 | SL-010 shipped (unplanned defect slice, SPEC-0007). NFR-002 → `done`, its wording tightened to say **any** 100,000-character body, and its measurement column now names the three tests. ASM-003 downgraded from NFR-002's guard. | Measuring NFR-002 before writing its test — the honest order — found it **failing**, not passing. SL-003's section pattern `<!--OPTIONAL:(id)-->([\s\S]*?)<!--/OPTIONAL:\1-->` re-scanned to end-of-string once per opening fence, so a body of unterminated fences cost O(n^2): 99,994 characters (inside FR-001's own CHECK bound) took 164.8 ms against a 100 ms budget, and each doubling quadrupled the time. Replaced with a single-pass fence scanner: 0.98 ms, linear. Behavior preservation verified against all 40 pre-existing tests. Two measurement lessons are recorded in SPEC-0007 rather than buried: an earlier single-shot 34.7 ms reading was retracted as unreproducible, and V8's regex tiering swings this body 5.5x depending on execution order, which made the first version of the benchmark order-dependent. | NFR-002, ASM-003, ASM-004, FR-005 |
| 2026-08-07 | 0.1.3 | SL-002 shipped (serialized, not parallel — `rules/07-SKILLS.md`'s ~2000 LOC threshold, all three of this round's slices touch `web/index.html`). FR-004, FR-007, FR-010 → `done`. | The PRD's own "first useful day is the end of SL-002" claim (section 13) is now true: variables render and copy to the clipboard, verified live in a browser with clipboard permissions, exact text confirmed. | FR-004, FR-007, FR-010, SL-002 |

---

## Appendix A: PRD self-check

- [x] Section 1 is understandable by a ten-year-old.
- [x] Every FR is testable as written, with concrete values in its acceptance criterion.
- [x] Every NFR has a number and a measurement method.
- [x] No banned word appears.
- [x] Out-of-scope section is non-empty (8 entries).
- [x] Every term used more than once appears in the Glossary exactly once.
- [x] Every data item classified confidential has a matching protective NFR (DR-002, DR-003 -> NFR-003, NFR-004, NFR-011).
- [x] Every metric has a stated gaming risk.
- [x] The slice plan's first entry is a Phase 0 skeleton. As of v0.1.1 it delivers FR-001 rather than none — a deliberate, recorded deviation (change log): the skeleton satisfies FR-001's criterion in full, and the status column stays honest.
- [x] No unfilled placeholder remains.
- [x] Every FR/NFR has a Status value.
- [x] No two requirements contradict.
