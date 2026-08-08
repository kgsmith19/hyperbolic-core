---
title: Render endpoint
spec_id: SPEC-0012-render-endpoint
slice: SL-009
status: done
created: 2026-08-08
owner: Kyle
completed: 2026-08-08
traces: [FR-013]
---

# SPEC-0012: Render endpoint

## 1. In one sentence

`prompt.render_prompt(p_name, p_config)` is a Postgres function exposed by PostgREST's existing RPC mechanism — an authenticated `GET` returns a prompt's rendered text, no application server added.

## 2. Why this, why now

FR-013, `Could` priority, the last open PRD requirement. Left unbuilt while `not-started` because the mechanism was a real decision (SR-02: "No application server... calls PostgREST directly"; CLAUDE.md forbids a new library/service without asking) — the same class of question NFR-010 faced, resolved there by an RPC (`toolbelt.core.log_run`) rather than a new service. Kyle directed this slice to proceed and picked no specific mechanism, so this spec makes the same call NFR-010 already set precedent for: **a PostgREST RPC, not a new service.** A Postgres function is not a new service — it is more `prompt` schema, exposed through the PostgREST layer this app already calls for every other read and write.

## 2.1 Corrections found while building this, not decided in advance

Two things this spec's own draft got wrong, both found only by testing live against the real project (not by inspection — the same discipline SPEC-0002 and SPEC-0007 record):

- **AC-001's "content type text/plain" is false for this project.** PostgREST's raw-media-type output for a scalar-returning function needs a server-level `db-plain-text-response` config this managed Supabase project doesn't expose to migrations — confirmed with two different `Accept` header variants, both `406 PGRST107`. Corrected to `application/json`, the same content type every other endpoint in this app already returns; the text itself is still exact, just JSON-quoted.
- **`grant execute ... to authenticated` alone does nothing.** Postgres grants `EXECUTE` to `PUBLIC` on every new function by default (unlike tables, which have no such default). The first mutation drill (revoking the `authenticated` grant) stayed green — `PUBLIC` was still covering it. Fixed by explicitly `revoke ... from public` before the `authenticated` grant, matching this schema's narrowest-surface posture everywhere else (SR-06).

## 3. Scope

### 3.1 In scope

- `prompt.render_prompt(p_name text, p_config text default null) returns text`, `stable` (so PostgREST allows `GET`, matching FR-013's own AC literally), `security invoker` (inherits the caller's RLS — no new policy, no new grant surface beyond `EXECUTE`)
- Variable substitution from a named configuration's stored `values`
- Section keep/drop from a named configuration's stored `sections`, fence comments stripped either way
- FR-010's guard reused: any variable still unfilled after substitution blocks with a `422` naming it, rather than leaking a literal `{{NAME}}` into the response
- Unknown prompt name → `404` (PostgREST's `PT404` convention)

### 3.2 Out of scope

| Not doing | Why not | Where it goes instead |
|---|---|---|
| Reproducing `render.mjs`'s exact section-parsing guarantees (malformed-fence-as-literal-text, interleaved-pair handling, the SPEC-0007 linear-time rewrite) | This is a second implementation in a second language by necessity (no server-side JS exists, SR-02) — matching every edge case would double all of SPEC-0006/0007's careful edge-case work for a `Could`-priority, near-zero-measured-usage endpoint (PRD ASM: U-002 usage "assume 0 until measured"). The well-formed-fence case (the only case this app's own ten pack prompts and every real prompt actually use) is what's built | If real usage surfaces a malformed body through this path, a follow-up slice ports the exact guarantee |
| A `p_config` that doesn't exist | Returns the same `404` PostgREST already gives — no special-cased message, no new mechanism | N/A |
| No configuration supplied at all (`p_config` omitted) | Renders with zero substitutions; any variable in the body is then "missing" by FR-010's own rule and blocks with `422` — the same guard, no special path | N/A |
| Rate limiting or auth beyond the existing Bearer-token/RLS pair | Not asked for; every other endpoint in this app has none either | N/A |

## 4. Acceptance criteria

| ID | Given | When | Then | Traces to |
|---|---|---|---|---|
| AC-001 | A prompt with a saved configuration `lean` (`values: {REPO: "toolbelt"}`, `sections: []`) | `GET /rest/v1/rpc/render_prompt?p_name=<title>&p_config=lean` with a valid Bearer token | `200`, `Content-Type` starts `application/json`, body is the exact rendered text, JSON-quoted | FR-013 |
| AC-002 | No prompt titled `does-not-exist` | The same `GET` is sent for that name | `404` | FR-013 |
| AC-003 | A prompt body containing `{{REPO}}`, no configuration supplied | The `GET` is sent with no `p_config` | Rejected, naming `REPO` in the error | FR-013, FR-010 |
| AC-004 | User A's prompt with a saved configuration | User B calls the RPC by that prompt's name | `404` — user B cannot even discover the prompt exists, the same as any other RLS-scoped read | FR-013, NFR-003 |

## 5. Properties (walked; only the non-vacuous ones get their own row)

| ID | Property | Kind | Traces |
|---|---|---|---|
| PROP-031 | Error totality: every call ends in `200` with text, or a named `4xx` (`404` unknown name/config, `422` missing variable) — never a `500`, never a partial body | Error totality | FR-013 |
| PROP-032 | Oracle/model: FR-013's own AC (AC-001) is the oracle | Oracle / model | FR-013 |
| PROP-033 | Invariant: the RPC never writes — `security invoker`, `stable`, and the function body contains no `insert`/`update`/`delete` | Invariant | FR-013 |
| PROP-034 | Idempotence, order independence, conservation, monotonicity: none apply — a single read-only call with no counter, no ordering-sensitive input | — | — |

## 6. Budget declaration

| Metric | Declared | Ceiling | Status |
|---|---|---|---|
| Net source LOC | ~35 (one PL/pgSQL function) | 300 | within |
| Test LOC | ~70 (`tests/render-endpoint.test.mjs`, new) | 200 | within |
| Source files touched | 1 (migration+down as one changeset) | 3 | within |
| Test files touched | 1 (new) | 3 | within |
| New tables | 0 | 1 | within |
| New columns | 0 | 6 | within |
| New endpoints | 1 (`rpc/render_prompt`) | 1 | within, at ceiling |
| New tests | 4 | 8 | within |
| New libraries / services | 0 (PostgREST RPC, not a new service) | 0 | within |

## 7. Changes

### 7.1 Data

```sql
create or replace function prompt.render_prompt(p_name text, p_config text default null)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_prompt_id uuid;
  v_body      text;
  v_values    jsonb := '{}'::jsonb;
  v_sections  text[] := '{}'::text[];
  v_id        text;
  v_key       text;
  v_missing   text[];
begin
  select id, body into v_prompt_id, v_body
    from prompt.prompt where lower(title) = lower(p_name) and is_active;
  if v_prompt_id is null then
    raise exception 'prompt not found' using errcode = 'PT404';
  end if;

  if p_config is not null then
    select values, sections into v_values, v_sections
      from prompt.configuration where prompt_id = v_prompt_id and name = p_config;
    if not found then
      raise exception 'configuration not found' using errcode = 'PT404';
    end if;
  end if;

  for v_id in
    select distinct (regexp_matches(v_body, '<!--OPTIONAL:([A-Za-z0-9_-]+)-->', 'g'))[1]
  loop
    if v_id = any(v_sections) then
      v_body := replace(replace(v_body,
        '<!--OPTIONAL:' || v_id || '-->', ''), '<!--/OPTIONAL:' || v_id || '-->', '');
    else
      v_body := regexp_replace(v_body,
        '<!--OPTIONAL:' || v_id || '-->.*?<!--/OPTIONAL:' || v_id || '-->', '', 'g');
    end if;
  end loop;

  for v_key in select jsonb_object_keys(v_values) loop
    v_body := replace(v_body, '{{' || v_key || '}}', v_values ->> v_key);
  end loop;

  select array_agg(distinct (regexp_matches(v_body, '\{\{([A-Z_][A-Z0-9_]*)\}\}', 'g'))[1])
    into v_missing;
  if v_missing is not null then
    raise exception 'missing variables: %', array_to_string(v_missing, ', ') using errcode = 'PT422';
  end if;

  return v_body;
end;
$$;

grant execute on function prompt.render_prompt(text, text) to authenticated;
```

Down: `drop function prompt.render_prompt(text, text);`

### 7.2 Application

None. This is an API-only capability for U-002 ("an agent acting for Kyle"), not a UI feature — the PRD's own use case draws no UI surface for it.

### 7.3 Files expected to change

| Path | Action | Why |
|---|---|---|
| `supabase/migrations/<ts>_prompt_create_render_function.sql` / `_down.sql` | create | AC-001..004 |
| `tests/render-endpoint.test.mjs` | create | AC-001..004 |

## 8. Test plan

| Test ID | Level | Traces | Failure mode | Why not cheaper |
|---|---|---|---|---|
| T-A-007 | acceptance | AC-001 | Wrong text, status, or content type | End-to-end is the AC as written |
| T-I-021 | integration | AC-002 | Unknown name doesn't 404 | `PT404` mapping is PostgREST's own convention, provable only live |
| T-I-022 | integration | AC-003 | Missing variable leaks as literal `{{NAME}}` | Real function execution needed |
| T-I-023 | integration | AC-004 | Non-owner reaches another user's prompt | RLS composition through an RPC needs a real second identity |

## 9. Rollback

Down migration drops the function. No table, no column, no data touched.

## 10. Definition of Done

- [x] T-A-007, T-I-021, T-I-022, T-I-023 written red-first. Two (T-I-021, T-I-023) happened to pass vacuously before the migration existed — PostgREST's own `404` for a missing function coincided with the expected status — flagged rather than silently accepted; both got dedicated post-migration mutations proving they discriminate the real mechanism, not the coincidence.
- [x] Ledger rows mutation-verified 2026-08-08 (see `specs/TEST-LEDGER.md`). One real bug found and fixed mid-drill: Postgres's default `PUBLIC` execute grant was masking the intended `authenticated`-only surface; `revoke ... from public` added, section 2.1.
- [x] Existing suite still green, unmodified: 58/58 (`node --test "tests/*.test.mjs"`).
- [x] PRD FR-013 → `done` (v0.1.14) — every PRD requirement is now `done` except nothing; FR-013 was the last one. `docs/SYSTEM-REQUIREMENTS.md` SR-30 added; `docs/DATA-FLOW-DIAGRAM.md` gains F-14.
- [x] Maintenance note for Issue #11 (2026-08-08): this slice has no dedicated UI surface today (RPC only), so the issue's browser drill applies to archive/configuration UI controls and console health while those flows run. Any future UI that calls `rpc/render_prompt` must be included in that same real-browser drill.
- [x] Spec moved to `done/`, dates set.
