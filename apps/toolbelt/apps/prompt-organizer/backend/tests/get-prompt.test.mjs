// m4-03/m4-04: real-Postgres proof of prompt.get_prompt's
// branching logic (pinned-vs-latest resolution, the PT404/PT422 raise
// conditions, and the p_values-over-p_config / p_sections-override merge
// order), run against an actual PostgreSQL engine, applying the real,
// committed migration files from disk verbatim -- never a reimplementation
// of get_prompt's logic. Mirrors the detection/skip mechanics
// apps/toolbelt/tests/registry-migrations-idempotency.test.mjs (m3-02) and
// apps/toolbelt/apps/idea-intake/backend/tests/intake-guards.test.mjs (m3-05)
// already established: this suite detects a usable local `psql` and skips
// itself cleanly -- via node:test's own skip mechanism, reported as
// SKIPPED, never silently omitted and never falsely green -- when no local
// Postgres engine is reachable.
//
// Why local Postgres rather than the live Supabase project this app's
// other suites call: get_prompt does not exist on the live project yet.
// Live-probed directly while implementing this issue (public anon key,
// POST rest/v1/rpc/get_prompt), the live project returns PGRST202 --
// "Could not find the function prompt.get_prompt(p_name) in the schema
// cache" -- because platform-migrations.yml has not deployed this
// migration pair yet (that happens on merge, via CI, not from this
// session). No amount of live network reachability substitutes for a
// database the function has actually been created on, so this suite's
// real proof has to come from applying the migration itself, here.
//
// HARNESS_SQL stubs exactly the pieces of Supabase's managed platform a
// bare local PostgreSQL 16 lacks (GoTrue's `auth` schema/auth.uid(), the
// anon/authenticated/service_role/authenticator API roles) -- local-only
// test scaffolding, never a committed migration, same technique
// intake-guards.test.mjs already uses.
//
// 20260812210000_prompt_usage_retention.sql is deliberately NOT applied
// here: it schedules prompt.purge_old_usage via pg_cron
// (select cron.schedule(...)), and this sandbox's local PostgreSQL 16 has
// no pg_cron extension installed (confirmed: not present in
// pg_available_extensions). That migration creates prompt.usage_monthly_agg
// and a cron job, neither of which get_prompt reads or depends on, so
// skipping it does not weaken this suite's coverage of get_prompt itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asAuthenticated,
  asJwtRole,
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
const GET_PROMPT_DOWN = join(PO_MIGRATIONS_DIR, "20260813120000_prompt_create_get_prompt_function_down.sql");
const GET_PROMPT_HARDENING_DOWN = join(
  PO_MIGRATIONS_DIR,
  "20260813140000_prompt_security_hardening_down.sql",
);
const GET_PROMPT_SOURCE_DOWN = join(PO_MIGRATIONS_DIR, "20260813150000_prompt_create_get_prompt_source_function_down.sql");

const OWNER_UUID = "9a50a35a-8a1e-4f0c-8495-7f26777982d8";
const STRANGER_UUID = "b2222222-2222-4222-8222-222222222222";
const AGENT_UUID = "c3333333-3333-4333-8333-333333333333";

const HARNESS_SQL = supabaseHarnessSql([OWNER_UUID, STRANGER_UUID]);

const OWNER_BOOTSTRAP_SQL = `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`;

const PG = createPostgresHarness("m4_03_get_prompt_test");
const { psql, psqlOk, applyMigrationWithRetry } = PG;
const SKIP_REASON = PG.skipReason;

// 20260807020000 sets a role-wide GUC (`alter role authenticator set
// pgrst.db_schemas = ...`, unscoped -- no `IN DATABASE`), which contends
// with any other scratch database applying the same migration concurrently
// (the other m3-05/m3-08 suites in this same tests tree do exactly that).
// Wrapping in one transaction makes a retry on Postgres's transient "tuple
// concurrently updated" error safe: DDL is transactional, so a failed
// attempt rolls back cleanly and a retry starts from scratch. Established
// in intake-guards.test.mjs; reused verbatim here for the same file.
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

function callGetPrompt(db, uuid, argsSql) {
  return psql(db, asAuthenticated(uuid, `select prompt.get_prompt(${argsSql});`));
}

function callGetPromptJson(db, uuid, argsSql) {
  const result = callGetPrompt(db, uuid, argsSql);
  assert.equal(result.status, 0, `expected success, got: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function callGetPromptError(db, uuid, argsSql) {
  const result = callGetPrompt(db, uuid, argsSql);
  assert.notEqual(result.status, 0, "expected an error, call succeeded");
  return result.stderr;
}

function callGetPromptSource(db, uuid, argsSql) {
  return psql(db, asAuthenticated(uuid, `select prompt.get_prompt_source(${argsSql});`));
}

function callGetPromptSourceJson(db, uuid, argsSql) {
  const result = callGetPromptSource(db, uuid, argsSql);
  assert.equal(result.status, 0, `expected success, got: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function callGetPromptSourceError(db, uuid, argsSql) {
  const result = callGetPromptSource(db, uuid, argsSql);
  assert.notEqual(result.status, 0, "expected an error, call succeeded");
  return result.stderr;
}

test(
  "real Postgres: contract shape -- valid name returns {text, version_no, rendered_at}",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/basic', 'Repo is {{REPO}}.');"));

      const out = callGetPromptJson(db, OWNER_UUID, "'gp/basic', null, null, '{\"REPO\":\"toolbelt\"}'::jsonb, null");

      assert.equal(out.text, "Repo is toolbelt.");
      assert.equal(out.version_no, 1);
      assert.match(out.rendered_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "rendered_at must be ISO 8601");
    });
  },
);

test("real Postgres: unknown name raises the PT404 class", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    const stderr = callGetPromptError(db, OWNER_UUID, "'gp/does-not-exist', null, null, null, null");
    assert.match(stderr, /PT404/);
  });
});

test("real Postgres: missing template variables after merge raise the PT422 class, naming the variable", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/needs-var', '{{A}} needs {{B}}');"));

    const stderr = callGetPromptError(db, OWNER_UUID, "'gp/needs-var', null, null, '{\"A\":\"x\"}'::jsonb, null");

    assert.match(stderr, /PT422/);
    assert.match(stderr, /\bB\b/, "the error must name the missing variable");
    assert.doesNotMatch(stderr, /\bA\b needs/, "must not name a variable that WAS supplied");
  });
});

test("real Postgres: p_values must be a JSON object", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/value-shape', '{{A}}');"));

    const stderr = callGetPromptError(db, OWNER_UUID, "'gp/value-shape', null, null, '[\"x\"]'::jsonb, null");

    assert.match(stderr, /PT422/);
    assert.match(stderr, /object of string values/i);
  });
});

test("real Postgres: every p_values member must be a JSON string", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/value-types', '{{A}}');"));

    const stderr = callGetPromptError(db, OWNER_UUID, "'gp/value-types', null, null, '{\"A\":1}'::jsonb, null");

    assert.match(stderr, /PT422/);
    assert.match(stderr, /only string values/i);
  });
});

test("real Postgres: an unknown pinned version_no on a real prompt raises PT404", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/pin-target', 'no vars here');"));

    const stderr = callGetPromptError(db, OWNER_UUID, "'gp/pin-target', 999, null, null, null");

    assert.match(stderr, /PT404/);
  });
});

test("real Postgres: an unknown configuration name raises PT404", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/cfg-target', 'no vars here');"));

    const stderr = callGetPromptError(db, OWNER_UUID, "'gp/cfg-target', null, 'does-not-exist', null, null");

    assert.match(stderr, /PT404/);
  });
});

test(
  "real Postgres: p_version omitted resolves the LIVE body and the max version_no (latest)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/pin-vs-latest', 'v1 body {{X}}');"));
      psqlOk(db, asAuthenticated(OWNER_UUID, "update prompt.prompt set body = 'v2 body {{X}}' where title = 'gp/pin-vs-latest';"));

      const out = callGetPromptJson(db, OWNER_UUID, "'gp/pin-vs-latest', null, null, '{\"X\":\"y\"}'::jsonb, null");

      assert.equal(out.text, "v2 body y");
      assert.equal(out.version_no, 2, "latest must resolve to the max version_no, not always 1");
    });
  },
);

test(
  "real Postgres: a pinned p_version resolves the body from prompt_version, NOT the live prompt.body",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/pin-vs-latest', 'v1 body {{X}}');"));
      psqlOk(db, asAuthenticated(OWNER_UUID, "update prompt.prompt set body = 'v2 body {{X}}' where title = 'gp/pin-vs-latest';"));

      const pinned = callGetPromptJson(db, OWNER_UUID, "'gp/pin-vs-latest', 1, null, '{\"X\":\"y\"}'::jsonb, null");

      assert.equal(pinned.text, "v1 body y", "pinned version_no=1 must render v1's body, not the live v2 body");
      assert.equal(pinned.version_no, 1);
    });
  },
);

test(
  "real Postgres: latest resolution on an archived prompt raises PT404 (no active latest to serve)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/archived', 'body {{X}}');"));
      psqlOk(db, asAuthenticated(OWNER_UUID, "update prompt.prompt set is_active = false where title = 'gp/archived';"));

      const stderr = callGetPromptError(db, OWNER_UUID, "'gp/archived', null, null, '{\"X\":\"y\"}'::jsonb, null");

      assert.match(stderr, /PT404/);
    });
  },
);

test(
  "real Postgres: a pinned p_version on an archived prompt still succeeds (a version pin survives archival)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/archived', 'body {{X}}');"));
      psqlOk(db, asAuthenticated(OWNER_UUID, "update prompt.prompt set is_active = false where title = 'gp/archived';"));

      const out = callGetPromptJson(db, OWNER_UUID, "'gp/archived', 1, null, '{\"X\":\"survives\"}'::jsonb, null");

      assert.equal(out.text, "body survives");
      assert.equal(out.version_no, 1);
    });
  },
);

test(
  "real Postgres: get_prompt_source conditionally returns an atomic latest body/version pair",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/source', 'v1 body {{X}}');"));

      const initial = callGetPromptSourceJson(db, OWNER_UUID, "'gp/source', null, null");
      assert.deepEqual(initial, { body: "v1 body {{X}}", version_no: 1, not_modified: false });

      const unchanged = callGetPromptSourceJson(db, OWNER_UUID, "'gp/source', null, 1");
      assert.deepEqual(unchanged, { body: null, version_no: 1, not_modified: true });

      psqlOk(db, asAuthenticated(OWNER_UUID, "update prompt.prompt set body = 'v2 body {{X}}' where title = 'gp/source';"));
      const changed = callGetPromptSourceJson(db, OWNER_UUID, "'gp/source', null, 1");
      assert.deepEqual(changed, { body: "v2 body {{X}}", version_no: 2, not_modified: false });
    });
  },
);

test(
  "real Postgres: get_prompt_source rejects archived latest while preserving pinned source reads",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/source-archive', 'body {{X}}');"));
      psqlOk(db, asAuthenticated(OWNER_UUID, "update prompt.prompt set is_active = false where title = 'gp/source-archive';"));

      assert.match(callGetPromptSourceError(db, OWNER_UUID, "'gp/source-archive', null, 1"), /PT404/);
      assert.deepEqual(
        callGetPromptSourceJson(db, OWNER_UUID, "'gp/source-archive', 1, null"),
        { body: "body {{X}}", version_no: 1, not_modified: false },
      );
    });
  },
);

test(
  "real Postgres: p_values overrides p_config on a shared key; config-only keys are kept (merge order)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          "insert into prompt.prompt (title, body) values " +
            "('gp/merge', 'Head. <!--OPTIONAL:extra-->Extra {{DETAIL}}.<!--/OPTIONAL:extra--> Tail {{BASE}}.') " +
            "returning id \\gset\n" +
            "insert into prompt.configuration (prompt_id, name, values, sections) values " +
            "(:'id', 'with-extra', '{\"BASE\":\"b\",\"DETAIL\":\"d\"}'::jsonb, '{extra}'::text[]);",
        ),
      );

      const out = callGetPromptJson(
        db,
        OWNER_UUID,
        "'gp/merge', null, 'with-extra', '{\"BASE\":\"OVERRIDDEN\"}'::jsonb, '{extra}'::text[]",
      );

      assert.equal(
        out.text,
        "Head. Extra d. Tail OVERRIDDEN.",
        "BASE must come from p_values (ad-hoc wins), DETAIL must still come from p_config",
      );
    });
  },
);

test(
  "real Postgres: p_sections overrides p_config's sections wholesale, not a union",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(
        db,
        asAuthenticated(
          OWNER_UUID,
          "insert into prompt.prompt (title, body) values " +
            "('gp/sections-override', 'Head. <!--OPTIONAL:extra-->Extra {{DETAIL}}.<!--/OPTIONAL:extra--> Tail {{BASE}}.') " +
            "returning id \\gset\n" +
            "insert into prompt.configuration (prompt_id, name, values, sections) values " +
            "(:'id', 'with-extra', '{\"BASE\":\"b\",\"DETAIL\":\"d\"}'::jsonb, '{extra}'::text[]);",
        ),
      );

      // p_sections = {} must DROP the extra section even though the saved
      // config included it -- a replacement, not a union. If it were a
      // union, DETAIL would still be required and the text would differ.
      const out = callGetPromptJson(db, OWNER_UUID, "'gp/sections-override', null, 'with-extra', '{\"BASE\":\"x\"}'::jsonb, '{}'::text[]");

      assert.equal(out.text, "Head.  Tail x.");
    });
  },
);

test(
  "real Postgres: a different authenticated user without prompt:get is denied before any row can leak",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/owner-only', 'no vars here');"));

      const stderr = callGetPromptError(db, STRANGER_UUID, "'gp/owner-only', null, null, null, null");

      assert.match(stderr, /42501/);
      assert.doesNotMatch(stderr, /no vars here/, "the response must not disclose prompt data");
    });
  },
);

test(
  "real Postgres: SECURITY DEFINER get_prompt never resolves a legacy foreign prompt, version, or configuration",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(
        db,
        `insert into prompt.prompt (user_id, title, body)
         values ('${STRANGER_UUID}', 'gp/foreign-legacy', 'foreign {{SECRET}}')
         returning id \\gset
         insert into prompt.configuration (prompt_id, name, values, sections)
         values (:'id', 'foreign-config', '{"SECRET":"must-not-leak"}'::jsonb, '{}'::text[]);`,
      );

      for (const args of [
        "'gp/foreign-legacy', null, null, null, null",
        "'gp/foreign-legacy', 1, null, '{\"SECRET\":\"x\"}'::jsonb, null",
        "'gp/foreign-legacy', null, 'foreign-config', null, null",
      ]) {
        const stderr = callGetPromptError(db, OWNER_UUID, args);
        assert.match(stderr, /PT404/);
        assert.doesNotMatch(stderr, /foreign|must-not-leak/i);
      }
    });
  },
);

test(
  "real Postgres: EXECUTE is not granted to anon, matching render_prompt's exact grant shape",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      const result = psql(db, "set role anon;\nselect prompt.get_prompt('anything', null, null, null, null);");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /permission denied/i);
    });
  },
);

test(
  "real Postgres: prompt_get_agent with prompt:get can execute both RPCs but cannot select their tables",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/agent', 'agent sees {{X}}');"));

      const rpc = psql(
        db,
        asJwtRole(
          "prompt_get_agent",
          { sub: AGENT_UUID, scope: "prompt:get" },
          "select prompt.get_prompt('gp/agent', null, null, '{\"X\":\"only rpc\"}'::jsonb, null);",
        ),
      );
      assert.equal(rpc.status, 0, rpc.stderr);
      assert.equal(JSON.parse(rpc.stdout.trim()).text, "agent sees only rpc");

      const sourceRpc = psql(
        db,
        asJwtRole(
          "prompt_get_agent",
          { sub: AGENT_UUID, scope: "prompt:get" },
          "select prompt.get_prompt_source('gp/agent', null, null);",
        ),
      );
      assert.equal(sourceRpc.status, 0, sourceRpc.stderr);
      assert.deepEqual(
        JSON.parse(sourceRpc.stdout.trim()),
        { body: "agent sees {{X}}", version_no: 1, not_modified: false },
      );

      const tableRead = psql(
        db,
        asJwtRole("prompt_get_agent", { sub: AGENT_UUID, scope: "prompt:get" }, "select title from prompt.prompt;"),
      );
      assert.notEqual(tableRead.status, 0);
      assert.match(tableRead.stderr, /permission denied/i);
    });
  },
);

test("real Postgres: prompt_get_agent without the exact prompt:get scope is denied by both RPCs", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/agent-scope', 'secret');"));

    for (const call of [
      "select prompt.get_prompt('gp/agent-scope', null, null, null, null);",
      "select prompt.get_prompt_source('gp/agent-scope', null, null);",
    ]) {
      const result = psql(
        db,
        asJwtRole("prompt_get_agent", { sub: AGENT_UUID, scope: "prompt:list prompt:get-all" }, call),
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /42501/);
    }
  });
});

test(
  "real Postgres: an authenticated database role without a JWT subject is denied",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/needs-session', 'no vars here');"));

      const result = psql(db, "set role authenticated;\nselect prompt.get_prompt('gp/needs-session', null, null, null, null);");

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /42501/);
    });
  },
);

test("real Postgres: reverse-order down migrations drop both prompt RPCs cleanly", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, readFileSync(GET_PROMPT_SOURCE_DOWN, "utf8"));
    const sourceResult = psql(db, "select prompt.get_prompt_source('anything', null, null);");
    assert.notEqual(sourceResult.status, 0);
    assert.match(sourceResult.stderr, /does not exist/i);

    psqlOk(db, readFileSync(GET_PROMPT_HARDENING_DOWN, "utf8"));

    const restored = psql(db, asAuthenticated(OWNER_UUID, "select prompt.get_prompt('anything', null, null, null, null);"));
    assert.notEqual(restored.status, 0);
    assert.match(restored.stderr, /PT404/, "hardening down restores the original function rather than dropping it");

    psqlOk(db, readFileSync(GET_PROMPT_DOWN, "utf8"));

    const result = psql(db, "select prompt.get_prompt('anything', null, null, null, null);");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not exist/i);
  });
});
