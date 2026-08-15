// m5-01-feat-po-shell-contract (docs/planning/issues/m5-01-feat-po-shell-contract.md;
// docs/planning/05-d-prompt-organizer.md section 11's PO-1a/PO-1b, realized
// against section 1.2's endpoint table): real-Postgres proof that every
// `prompt.*` PostgREST endpoint serves per its stated grant/RLS contract
// (PO-1a), and that a request bearing a token whose subject is NOT the
// owner UUID gets zero rows on every select and a refused write -- an
// actual RLS denial, not a silent no-op -- on every `prompt.*` table
// (PO-1b).
//
// Applies the real, committed migration files from disk verbatim, using
// the exact real-Postgres harness pattern already established in this same
// tests/ directory by get-prompt.test.mjs and seed.test.mjs:
// tests/postgres-harness.mjs's `createPostgresHarness`, `supabaseHarnessSql`,
// and `asAuthenticated` helpers; skips cleanly via node:test's own skip
// mechanism (reported as SKIPPED, never silently omitted and never falsely
// green) when no local Postgres is reachable; uses `applyMigrationWithRetry`
// specifically for 20260807020000_prompt_create_prompt.sql, whose unscoped
// `alter role authenticator set pgrst.db_schemas = ...` (no `IN DATABASE`)
// can transiently collide with another suite in this same tests run
// applying the identical statement against its own scratch database --
// wrapping in one transaction makes a retry on Postgres's transient "tuple
// concurrently updated" error safe, since DDL is transactional and a failed
// attempt rolls back cleanly. See get-prompt.test.mjs's own header comment
// for the fuller rationale; reused verbatim here for the same reason.
//
// Deep branching coverage this suite deliberately does NOT duplicate (per
// the m5-01 issue's own scope note):
// - render_prompt's PT404/PT422 branches: tests/render-endpoint.test.mjs,
//   against the live Supabase project. This suite adds only the local
//   real-Postgres happy path plus the owner/stranger auth boundary.
// - get_prompt's pinned-vs-latest resolution, PT404/PT422 conditions, and
//   the p_values-over-p_config / p_sections-override merge order:
//   tests/get-prompt.test.mjs, exhaustively, against this same harness.
//   This suite proves only the documented response SHAPE and the
//   owner/stranger auth boundary for get_prompt and get_prompt_source,
//   against a plain prompt this suite inserts directly (not a
//   seed-migration row).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asAuthenticated,
  createPostgresHarness,
  supabaseHarnessSql,
} from "../../../../tests/postgres-harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
const PO_MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");

const PLATFORM_BOOTSTRAP_UP = join(ROOT_MIGRATIONS_DIR, "20260812140000_platform_owner_bootstrap.sql");

const PO_MIGRATIONS_IN_ORDER = [
  "20260807020000_prompt_create_prompt.sql",
  "20260807041000_prompt_versions_and_unique_title.sql",
  "20260807051000_prompt_create_tag.sql",
  "20260807070000_prompt_create_usage.sql",
  "20260808000000_prompt_add_is_active.sql",
  "20260808100000_prompt_create_configuration.sql",
  "20260808130000_prompt_create_render_function.sql",
  "20260812180000_prompt_owner_pin.sql",
  "20260812200000_prompt_observed_query_indexes.sql",
  "20260813120000_prompt_create_get_prompt_function.sql",
  "20260813140000_prompt_security_hardening.sql",
  "20260813150000_prompt_create_get_prompt_source_function.sql",
];

const OWNER_UUID = "9a50a35a-8a1e-4f0c-8495-7f26777982d8";
const STRANGER_UUID = "b2222222-2222-4222-8222-222222222222";

const HARNESS_SQL = supabaseHarnessSql([OWNER_UUID, STRANGER_UUID]);

const OWNER_BOOTSTRAP_SQL = `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`;

const PG = createPostgresHarness("m5_01_contract_test");
const { psql, psqlOk, applyMigrationWithRetry } = PG;
const SKIP_REASON = PG.skipReason;

function withMigratedDb(fn) {
  return PG.withDatabase((db) => {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, OWNER_BOOTSTRAP_SQL);
    for (const name of PO_MIGRATIONS_IN_ORDER) {
      const sql = readFileSync(join(PO_MIGRATIONS_DIR, name), "utf8");
      if (name === "20260807020000_prompt_create_prompt.sql") applyMigrationWithRetry(db, sql);
      else psqlOk(db, sql);
    }
    return fn(db);
  });
}

function owner(sqlText) {
  return asAuthenticated(OWNER_UUID, sqlText);
}

function stranger(sqlText) {
  return asAuthenticated(STRANGER_UUID, sqlText);
}

// PO-1b: "refuse writes ... " means the write attempt itself must fail, not
// silently no-op. A rejected write here must be a real backend error --
// non-zero psql exit status, a 42501 (insufficient_privilege) class in
// stderr, naming the RLS policy violation explicitly.
function assertRlsRejected(result, label) {
  assert.notEqual(result.status, 0, `expected ${label} to be rejected outright, but psql exited 0 (a silent no-op is not a refusal)`);
  assert.match(result.stderr, /42501/, `expected a 42501 RLS-violation error for ${label}, got: ${result.stderr}`);
  assert.match(result.stderr, /row-level security policy/i, `expected an explicit RLS-policy violation message for ${label}, got: ${result.stderr}`);
}

// prompt_version and usage carry no UPDATE/DELETE grant at all -- distinct
// from an RLS refusal (a row-visibility/ownership check), this is a
// Postgres ACL (GRANT) denial: the privilege to attempt the statement was
// never given, so RLS never even gets evaluated.
function assertGrantDenied(result, label) {
  assert.notEqual(result.status, 0, `expected ${label} to be rejected outright, but psql exited 0`);
  assert.match(result.stderr, /42501/, `expected a 42501 insufficient-privilege error for ${label}, got: ${result.stderr}`);
  assert.match(result.stderr, /permission denied/i, `expected a grant-level permission-denied error for ${label}, got: ${result.stderr}`);
}

// ---------------------------------------------------------------------------
// /rest/v1/prompt -- GET, POST, PATCH
// ---------------------------------------------------------------------------

test("real Postgres: /rest/v1/prompt GET -- owner SELECT returns the owner's own rows", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/select-a', 'body a'), ('contract/select-b', 'body b');"));

    const count = psqlOk(db, owner("select count(*) from prompt.prompt;")).trim();

    assert.equal(count, "2", "owner select must return the rows the owner just created");
  });
});

test(
  "real Postgres: /rest/v1/prompt POST -- the insert grant accepts title+body; id, user_id, created_at, and is_active are all silently defaulted, never left client-controlled",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const row = psqlOk(
        db,
        owner("insert into prompt.prompt (title, body) values ('contract/insert-defaults', 'body') returning id, user_id, created_at, is_active;"),
      ).trim();
      const [id, userId, createdAt, isActive] = row.split("|");

      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "id must default to a generated uuid");
      assert.equal(userId, OWNER_UUID, "user_id must default to the authenticated caller, not be left for the client to set");
      assert.ok(Date.now() - new Date(createdAt).getTime() < 10000, `created_at must default to "now", got ${createdAt}`);
      assert.equal(isActive, "t", "is_active must default to true");
    });
  },
);

test(
  "real Postgres: /rest/v1/prompt POST -- the owner_rw WITH CHECK clause refuses an insert assigning the row to anyone but the owner, even from the owner's own authenticated session",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const result = psql(db, owner(`insert into prompt.prompt (title, body, user_id) values ('contract/forge-owner', 'body', '${STRANGER_UUID}');`));

      assertRlsRejected(result, "prompt insert forging user_id to a non-owner value");
    });
  },
);

test(
  "real Postgres: /rest/v1/prompt PATCH -- the update grant covers only title, body, is_active; created_at and user_id have no update grant at all",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/update-scope', 'v1');"));

      const updated = psqlOk(
        db,
        owner(
          "update prompt.prompt set title = 'contract/update-scope-renamed', body = 'v2', is_active = false " +
            "where title = 'contract/update-scope' returning title, body, is_active;",
        ),
      ).trim();
      assert.equal(updated, "contract/update-scope-renamed|v2|f", "title, body, and is_active must all be updatable per the documented grant");

      const createdAtAttempt = psql(db, owner("update prompt.prompt set created_at = now() where title = 'contract/update-scope-renamed';"));
      assertGrantDenied(createdAtAttempt, "prompt UPDATE of created_at (no column grant)");

      const userIdAttempt = psql(db, owner(`update prompt.prompt set user_id = '${STRANGER_UUID}' where title = 'contract/update-scope-renamed';`));
      assertGrantDenied(userIdAttempt, "prompt UPDATE of user_id (no column grant)");
    });
  },
);

test(
  "real Postgres: /rest/v1/prompt -- a STRANGER-subject token gets zero rows on select and is refused on insert (PO-1b)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/stranger-boundary', 'owner body');"));

      const strangerCount = psqlOk(db, stranger("select count(*) from prompt.prompt;")).trim();
      assert.equal(strangerCount, "0", "a non-owner-subject token must see zero prompt rows, never the owner's data");

      const insertAttempt = psql(db, stranger("insert into prompt.prompt (title, body) values ('contract/stranger-write', 'stranger body');"));
      assertRlsRejected(insertAttempt, "STRANGER prompt insert (default user_id = STRANGER's own uid, which never equals the owner)");
    });
  },
);

// ---------------------------------------------------------------------------
// /rest/v1/prompt_version -- GET, POST only; no UPDATE or DELETE grant
// (05-d section 1.2: "no UPDATE or DELETE grant exists, which is the
// immutability mechanism")
// ---------------------------------------------------------------------------

test(
  "real Postgres: /rest/v1/prompt_version GET/POST -- owner SELECT sees the trigger-recorded version, and a raw client INSERT with a manually chosen version_no is grant-legal",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/version-grant', 'v1 body');"));

      const selected = psqlOk(
        db,
        owner("select count(*) from prompt.prompt_version where prompt_id = (select id from prompt.prompt where title = 'contract/version-grant');"),
      ).trim();
      assert.equal(selected, "1", "the record_version trigger must already have inserted version 1, and owner SELECT must see it");

      // In practice only the record_version trigger inserts these rows; this
      // proves the raw INSERT grant itself is real, independent of the
      // trigger, per the m5-01 issue's own instruction.
      const inserted = psqlOk(
        db,
        owner(
          "insert into prompt.prompt_version (prompt_id, version_no, body, user_id, created_at) " +
            "select id, 7, 'manually inserted body', user_id, now() from prompt.prompt where title = 'contract/version-grant' " +
            "returning version_no;",
        ),
      ).trim();
      assert.equal(inserted, "7", "the INSERT grant on prompt_version must be real -- a raw, manually-versioned insert must succeed");
    });
  },
);

test(
  "real Postgres: /rest/v1/prompt_version -- no UPDATE or DELETE grant exists; both are rejected for lack of privilege, proving the immutability mechanism as a real grant denial",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/version-immutable', 'v1 body');"));

      const updateAttempt = psql(
        db,
        owner("update prompt.prompt_version set body = 'tampered' where prompt_id = (select id from prompt.prompt where title = 'contract/version-immutable');"),
      );
      assertGrantDenied(updateAttempt, "prompt_version UPDATE");

      const deleteAttempt = psql(
        db,
        owner("delete from prompt.prompt_version where prompt_id = (select id from prompt.prompt where title = 'contract/version-immutable');"),
      );
      assertGrantDenied(deleteAttempt, "prompt_version DELETE");
    });
  },
);

test("real Postgres: /rest/v1/prompt_version -- a STRANGER-subject token gets zero rows on select", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/version-stranger', 'v1 body');"));

    const strangerCount = psqlOk(db, stranger("select count(*) from prompt.prompt_version;")).trim();
    assert.equal(strangerCount, "0", "a non-owner-subject token must see zero prompt_version rows");
  });
});

// ---------------------------------------------------------------------------
// /rest/v1/tag -- GET, POST only; scoped via the parent prompt's ownership,
// not a user_id column of tag's own
// ---------------------------------------------------------------------------

test("real Postgres: /rest/v1/tag GET/POST -- owner SELECT/INSERT work, scoped via the parent prompt's ownership", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/tag-scope', 'body');"));

    const inserted = psqlOk(
      db,
      owner("insert into prompt.tag (prompt_id, tag) select id, 'contract-tag' from prompt.prompt where title = 'contract/tag-scope' returning tag;"),
    ).trim();
    assert.equal(inserted, "contract-tag");

    const selected = psqlOk(db, owner("select count(*) from prompt.tag where tag = 'contract-tag';")).trim();
    assert.equal(selected, "1");
  });
});

test(
  "real Postgres: /rest/v1/tag -- a STRANGER-subject token gets zero rows on select and is refused inserting a tag onto the owner's known prompt_id",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const promptId = psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/tag-stranger', 'body') returning id;")).trim();
      psqlOk(db, owner(`insert into prompt.tag (prompt_id, tag) values ('${promptId}', 'owner-tag');`));

      const strangerCount = psqlOk(db, stranger("select count(*) from prompt.tag;")).trim();
      assert.equal(strangerCount, "0", "a non-owner-subject token must see zero tag rows");

      // The prompt_id is an explicit, known literal here -- not sourced from
      // a STRANGER-run `select ... from prompt.prompt`, which RLS would
      // already empty out, making an `insert ... select` trivially "succeed"
      // by inserting zero rows. Using the real, known id proves the WITH
      // CHECK clause itself rejects the write.
      const insertAttempt = psql(db, stranger(`insert into prompt.tag (prompt_id, tag) values ('${promptId}', 'stranger-tag');`));
      assertRlsRejected(insertAttempt, "STRANGER tag insert against the owner's known prompt_id");
    });
  },
);

// ---------------------------------------------------------------------------
// /rest/v1/usage -- GET, POST only; append-only, composite FK to version
// ---------------------------------------------------------------------------

test("real Postgres: /rest/v1/usage GET/POST -- owner SELECT/INSERT work", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/usage-scope', 'body');"));

    const inserted = psqlOk(
      db,
      owner("insert into prompt.usage (prompt_id, version_no) select id, 1 from prompt.prompt where title = 'contract/usage-scope' returning version_no;"),
    ).trim();
    assert.equal(inserted, "1");

    const selected = psqlOk(db, owner("select count(*) from prompt.usage;")).trim();
    assert.equal(selected, "1");
  });
});

test(
  "real Postgres: /rest/v1/usage -- no UPDATE or DELETE grant exists (append-only log, same posture as prompt_version)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/usage-immutable', 'body');"));
      psqlOk(db, owner("insert into prompt.usage (prompt_id, version_no) select id, 1 from prompt.prompt where title = 'contract/usage-immutable';"));

      const updateAttempt = psql(
        db,
        owner("update prompt.usage set config_name = 'tampered' where prompt_id = (select id from prompt.prompt where title = 'contract/usage-immutable');"),
      );
      assertGrantDenied(updateAttempt, "usage UPDATE");

      const deleteAttempt = psql(
        db,
        owner("delete from prompt.usage where prompt_id = (select id from prompt.prompt where title = 'contract/usage-immutable');"),
      );
      assertGrantDenied(deleteAttempt, "usage DELETE");
    });
  },
);

test(
  "real Postgres: /rest/v1/usage -- a STRANGER-subject token gets zero rows on select and is refused inserting a usage row against the owner's known prompt_id/version_no",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const promptId = psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/usage-stranger', 'body') returning id;")).trim();
      psqlOk(db, owner(`insert into prompt.usage (prompt_id, version_no) values ('${promptId}', 1);`));

      const strangerCount = psqlOk(db, stranger("select count(*) from prompt.usage;")).trim();
      assert.equal(strangerCount, "0");

      const insertAttempt = psql(db, stranger(`insert into prompt.usage (prompt_id, version_no) values ('${promptId}', 1);`));
      assertRlsRejected(insertAttempt, "STRANGER usage insert against the owner's known prompt_id/version_no");
    });
  },
);

// ---------------------------------------------------------------------------
// /rest/v1/configuration -- GET, POST only; PK (prompt_id, name)
// ---------------------------------------------------------------------------

test("real Postgres: /rest/v1/configuration GET/POST -- owner SELECT/INSERT work", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/config-scope', 'body {{X}}');"));

    const inserted = psqlOk(
      db,
      owner(
        "insert into prompt.configuration (prompt_id, name, values, sections) " +
          "select id, 'contract-cfg', '{\"X\":\"y\"}'::jsonb, '{}'::text[] from prompt.prompt where title = 'contract/config-scope' " +
          "returning name;",
      ),
    ).trim();
    assert.equal(inserted, "contract-cfg");

    const selected = psqlOk(db, owner("select count(*) from prompt.configuration where name = 'contract-cfg';")).trim();
    assert.equal(selected, "1");
  });
});

test(
  "real Postgres: /rest/v1/configuration -- a STRANGER-subject token gets zero rows on select and is refused inserting against the owner's known prompt_id",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const promptId = psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/config-stranger', 'body') returning id;")).trim();
      psqlOk(db, owner(`insert into prompt.configuration (prompt_id, name) values ('${promptId}', 'owner-cfg');`));

      const strangerCount = psqlOk(db, stranger("select count(*) from prompt.configuration;")).trim();
      assert.equal(strangerCount, "0");

      const insertAttempt = psql(db, stranger(`insert into prompt.configuration (prompt_id, name) values ('${promptId}', 'stranger-cfg');`));
      assertRlsRejected(insertAttempt, "STRANGER configuration insert against the owner's known prompt_id");
    });
  },
);

// ---------------------------------------------------------------------------
// /rest/v1/rpc/render_prompt -- EXECUTE granted to authenticated only
// ---------------------------------------------------------------------------

test(
  "real Postgres: /rest/v1/rpc/render_prompt -- owner call against an owned active prompt renders text (PT404/PT422 branches already covered live by render-endpoint.test.mjs)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/render-happy', 'Repo is {{REPO}}.');"));
      psqlOk(
        db,
        owner(
          "insert into prompt.configuration (prompt_id, name, values, sections) " +
            "select id, 'lean', '{\"REPO\":\"toolbelt\"}'::jsonb, '{}'::text[] from prompt.prompt where title = 'contract/render-happy';",
        ),
      );

      const rendered = psqlOk(db, owner("select prompt.render_prompt('contract/render-happy', 'lean');")).trim();
      assert.equal(rendered, "Repo is toolbelt.");
    });
  },
);

test(
  "real Postgres: /rest/v1/rpc/render_prompt -- a STRANGER calling it against the owner's prompt name gets not-found, proving it cannot read across the ownership boundary",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/render-boundary', 'no vars here');"));

      const result = psql(db, stranger("select prompt.render_prompt('contract/render-boundary', null);"));

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PT404/, "a STRANGER must see the same not-found error as an unknown name, never the owner's body");
    });
  },
);

// ---------------------------------------------------------------------------
// /rest/v1/rpc/get_prompt -- owner JWT or scoped agent token; see
// get-prompt.test.mjs for exhaustive branch coverage
// ---------------------------------------------------------------------------

test(
  "real Postgres: /rest/v1/rpc/get_prompt -- owner call against a directly-inserted prompt returns the documented {text, version_no, rendered_at} shape",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/get-prompt-shape', 'Hello {{NAME}}.');"));

      const out = JSON.parse(
        psqlOk(db, owner("select prompt.get_prompt('contract/get-prompt-shape', null, null, '{\"NAME\":\"world\"}'::jsonb, null);")).trim(),
      );

      assert.equal(out.text, "Hello world.");
      assert.equal(out.version_no, 1);
      assert.match(out.rendered_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "rendered_at must be ISO 8601");
      assert.deepEqual(Object.keys(out).sort(), ["rendered_at", "text", "version_no"], "the response must carry exactly the documented fields");
    });
  },
);

test("real Postgres: /rest/v1/rpc/get_prompt -- a STRANGER call gets the documented 42501 not-authorized exception", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/get-prompt-boundary', 'no vars here');"));

    const result = psql(db, stranger("select prompt.get_prompt('contract/get-prompt-boundary', null, null, null, null);"));

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /42501/);
    assert.match(result.stderr, /not authorized/i);
    assert.doesNotMatch(result.stderr, /no vars here/, "the auth-boundary error must not disclose prompt data");
  });
});

// ---------------------------------------------------------------------------
// /rest/v1/rpc/get_prompt_source -- execute-only, no caller table grants
// ---------------------------------------------------------------------------

test(
  "real Postgres: /rest/v1/rpc/get_prompt_source -- owner call against a directly-inserted prompt returns the documented {body, version_no, not_modified} shape",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/get-source-shape', 'raw {{TEMPLATE}} body');"));

      const out = JSON.parse(psqlOk(db, owner("select prompt.get_prompt_source('contract/get-source-shape', null, null);")).trim());

      assert.deepEqual(out, { body: "raw {{TEMPLATE}} body", version_no: 1, not_modified: false });
    });
  },
);

test(
  "real Postgres: /rest/v1/rpc/get_prompt_source -- a STRANGER call gets the documented 42501 not-authorized exception",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/get-source-boundary', 'secret body');"));

      const result = psql(db, stranger("select prompt.get_prompt_source('contract/get-source-boundary', null, null);"));

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /42501/);
      assert.match(result.stderr, /not authorized/i);
      assert.doesNotMatch(result.stderr, /secret body/, "the auth-boundary error must not disclose prompt data");
    });
  },
);

// ---------------------------------------------------------------------------
// /auth/v1/token?grant_type=password -- section 1.2 marks this RETIRED for
// the UI; it remains only for CI token minting against the fenced test
// schema. It is a Supabase Auth (GoTrue) endpoint, not a `prompt` schema
// table or RPC -- a bare local PostgreSQL 16 has no GoTrue, so this
// real-Postgres harness has nothing to exercise for this row. Out of this
// suite's scope by construction, not by oversight.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PO-1b, consolidated: one STRANGER-subject token, one pass, every
// prompt.* table -- zero rows on every select, a real RLS-refused write on
// every insert. The per-endpoint tests above already prove this table by
// table; this test proves it holds simultaneously, in one session, across
// the whole schema, matching PO-1b's literal wording.
// ---------------------------------------------------------------------------

test(
  "real Postgres: PO-1b -- a single STRANGER-subject token gets zero rows on every select and a real RLS-refused write on every prompt.* table, in one pass",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const promptId = psqlOk(db, owner("insert into prompt.prompt (title, body) values ('contract/po-1b-sweep', 'body {{X}}') returning id;")).trim();
      psqlOk(db, owner(`insert into prompt.tag (prompt_id, tag) values ('${promptId}', 'sweep-tag');`));
      psqlOk(
        db,
        owner(`insert into prompt.configuration (prompt_id, name, values, sections) values ('${promptId}', 'sweep-cfg', '{"X":"y"}'::jsonb, '{}'::text[]);`),
      );
      psqlOk(db, owner(`insert into prompt.usage (prompt_id, version_no) values ('${promptId}', 1);`));

      for (const [table, selectSql] of [
        ["prompt", "select count(*) from prompt.prompt;"],
        ["prompt_version", "select count(*) from prompt.prompt_version;"],
        ["tag", "select count(*) from prompt.tag;"],
        ["usage", "select count(*) from prompt.usage;"],
        ["configuration", "select count(*) from prompt.configuration;"],
      ]) {
        const count = psqlOk(db, stranger(selectSql)).trim();
        assert.equal(count, "0", `PO-1b: STRANGER select on prompt.${table} must return zero rows`);
      }

      const promptWrite = psql(db, stranger("insert into prompt.prompt (title, body) values ('contract/po-1b-write', 'x');"));
      assertRlsRejected(promptWrite, "PO-1b prompt insert");

      const versionWrite = psql(
        db,
        stranger(`insert into prompt.prompt_version (prompt_id, version_no, body, user_id, created_at) values ('${promptId}', 2, 'forged', '${STRANGER_UUID}', now());`),
      );
      assertRlsRejected(versionWrite, "PO-1b prompt_version insert");

      const tagWrite = psql(db, stranger(`insert into prompt.tag (prompt_id, tag) values ('${promptId}', 'stranger-sweep-tag');`));
      assertRlsRejected(tagWrite, "PO-1b tag insert");

      const usageWrite = psql(db, stranger(`insert into prompt.usage (prompt_id, version_no) values ('${promptId}', 1);`));
      assertRlsRejected(usageWrite, "PO-1b usage insert");

      const configWrite = psql(db, stranger(`insert into prompt.configuration (prompt_id, name) values ('${promptId}', 'stranger-sweep-cfg');`));
      assertRlsRejected(configWrite, "PO-1b configuration insert");
    });
  },
);
