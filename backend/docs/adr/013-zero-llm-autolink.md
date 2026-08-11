# ADR 013: Zero-LLM auto-link of attendees to the person spine

## Decision

**Exact match only, no LLM, no fuzz.** B1 deliberately created calendar
`attendee` entities with identity field `email` (singular), separate from
`person` in `relationships` whose identity field is `emails` (array), so
ingestion could never merge feed data onto the spine (ADR 012). B2 links the
two with a deterministic pass, `src/domains/calendar/autolink.py`: an attendee
matches a person only when their addresses are **equal after normalization**.
Normalization is lowercase + strip surrounding whitespace, and nothing else —
no edit distance, no name similarity, no embeddings, no model call. A display
name is never matched on: two "Dana Chen"s are two people, and a shared name
is not evidence.

**The one alias rule is Google's, and it is provider-specific.** For
`gmail.com` and `googlemail.com` only, the local part's dots are removed, a
`+tag` suffix is dropped, and `googlemail.com` canonicalizes to `gmail.com` —
because those are documented properties of one Google mailbox. The rule is
**not** generalized: at most other providers `a.b@host` and `ab@host` are
different mailboxes belonging to different people, so applying it broadly
would fabricate matches on the identity spine. Another provider's alias scheme
is a new ADR, not a quiet addition to the set.

**Edge, never merge (invariant 4).** A confident match — exactly one candidate
person — emits `attendee -[is_person]-> person` via `relate`, carrying the ADR
010 provenance envelope `{method: "autolink.exact_email", confidence: 1.0,
source_entity_ids: [attendee, person]}`. The pass writes nothing else: it never
mutates attendee or person attributes, never merges entities, never supersedes
or deletes. One identity spine means an automated pass may *point at* the
spine; rewriting it stays a human act, reversible by superseding one edge
rather than by unpicking a merge. Re-runs are idempotent — an existing active
`is_person` edge short-circuits the link, so an unchanged graph emits zero new
events.

**Review instead of guess.** Two or more candidate people for one address, or a
single candidate that contradicts an existing `is_person` link, produces a
`link_review` entity (calendar domain, registry data) instead of an edge:
`{review_key, attendee_id, candidate_person_ids, reason, method, detected_at}`.
That is the dedup-review queue. Zero candidates produces **nothing at all** —
no edge and no review item — because a stranger on an invite is not a defect
and a queue full of strangers is a queue nobody reads. Review items are
idempotent on `{attendee, reason}` + candidate set, so a standing ambiguity
does not churn the log.

**The review queue holds IDs and a reason code, never PII.** `link_review`
carries no email, no display name, no free text, and therefore no `x-pii`
fields. This follows ADR 012's finding: `entity.search` is a generated tsvector
over `attributes::text` and `forget()` is strictly per-entity, so an email
copied into a review item would survive erasure of the attendee it belongs to
and stay full-text searchable — reachable through chat, whose context reads
every active domain. A reviewer resolves an item by reading the referenced
entities, which remain the single place that PII lives and the single place
erasure has to reach.

**Context.** The pass reads both domains and writes an edge whose endpoints
span both, and `relate` requires write on *every* domain an endpoint belongs
to. It runs as `python -m domains.calendar.autolink` on the same scheduler
path as ingestion, under a code-built AccessContext of exactly
`calendar:read`, `calendar:write`, `relationships:read`,
`relationships:write` — narrow by construction, never `AccessContext.all()`,
the ADR 012 operator-script pattern. Agent tokens stay read-only (ADR 010).

**No new deployable and no new repo** (ADR 009): the pass consumes calendar
output and lives in the existing calendar module as a second entry point
beside `ingest`.

## Consequences

- Attendee → person is a queryable edge, so a briefing can name the people in
  tomorrow's meetings without the identity spine having absorbed feed data.
- Everything the pass will not decide is visible and countable
  (`find(ctx, type_name="link_review")`) rather than silently guessed or
  silently dropped.
- The person index is built with one `find` per run and matched in memory;
  matching against thousands of people is a measurement away from being a
  problem, not a design change.
- Recall is deliberately low: a person whose calendar address is not on their
  `person` record simply does not match. Adding the address to the spine is the
  fix, and it is a human edit.

## Revisit when

Real data shows attendees that *should* match and do not, and the gap is not
closed by adding the address to the person record — then fuzzy matching, LLM
assistance, or auto-merge can be argued, and each needs its own ADR because
each removes a human from the identity spine. Also revisit when the review
queue needs a UI (it is currently entities only), when a non-Google provider's
alias scheme is genuinely needed, or when B3's scheduler changes how operator
passes authenticate.
