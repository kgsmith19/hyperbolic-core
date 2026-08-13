// m4-03-feat-po-injection-rpc: real-Postgres proof of prompt.get_prompt's
// branching logic (pinned-vs-latest resolution, the PT404/PT422 raise
// conditions, and the p_values-over-p_config / p_sections-override merge
// order), run against an actual PostgreSQL engine, applying the real,
// committed migration files from disk verbatim -- never a reimplementation
// of get_prompt's logic. Mirrors the detection/skip mechanics
// apps/toolbelt/tests/registry-migrations-idempotency.test.mjs (m3-02) and
// apps/toolbelt/apps/idea-intake/tests/intake-guards.test.mjs (m3-05)
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
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "supabase", "migrations");
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
];
const GET_PROMPT_DOWN = join(PO_MIGRATIONS_DIR, "20260813120000_prompt_create_get_prompt_function_down.sql");

const OWNER_UUID = "9a50a35a-8a1e-4f0c-8495-7f26777982d8";
const STRANGER_UUID = "b2222222-2222-4222-8222-222222222222";

const HARNESS_SQL = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('app.test_uid', true), '')::uuid $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end
$$;

insert into auth.users (id) values ('${OWNER_UUID}'), ('${STRANGER_UUID}');
`;

const OWNER_BOOTSTRAP_SQL = `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`;

function tryRunner(cmd, args) {
  try {
    const result = spawnSync(cmd, [...args, "-d", "postgres", "-tAc", "select 1;"], { encoding: "utf8", timeout: 5000 });
    return result.status === 0 && result.stdout.trim() === "1";
  } catch {
    return false;
  }
}

function detectRunner() {
  if (tryRunner("psql", [])) return { cmd: "psql", args: [] };
  if (tryRunner("sudo", ["-n", "-u", "postgres", "psql"])) return { cmd: "sudo", args: ["-n", "-u", "postgres", "psql"] };
  return null;
}

const RUNNER = detectRunner();
const SKIP_REASON = RUNNER
  ? false
  : "no local Postgres reachable (tried direct `psql` and `sudo -n -u postgres psql`); get_prompt does not exist " +
    "on the live Supabase project yet (confirmed live: rpc/get_prompt returns PGRST202), so this suite has " +
    "nothing honest to assert against either target without a reachable engine";

function psql(dbName, sqlText) {
  // VERBOSITY=verbose: psql's default error display omits the SQLSTATE
  // ("ERROR:  prompt not found"), which is exactly the PT404/PT422 class
  // these tests assert on; verbose mode prefixes it ("ERROR:  PT404:
  // prompt not found"), matching what a PostgREST-fronted caller actually
  // sees in the `code` field of its JSON error body.
  return spawnSync(
    RUNNER.cmd,
    [...RUNNER.args, "-d", dbName, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-tA", "-q"],
    { encoding: "utf8", input: sqlText, timeout: 20000 },
  );
}

function psqlOk(dbName, sqlText) {
  const result = psql(dbName, sqlText);
  assert.equal(result.status, 0, `psql failed against ${dbName}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

// 20260807020000 sets a role-wide GUC (`alter role authenticator set
// pgrst.db_schemas = ...`, unscoped -- no `IN DATABASE`), which contends
// with any other scratch database applying the same migration concurrently
// (the other m3-05/m3-08 suites in this same tests tree do exactly that).
// Wrapping in one transaction makes a retry on Postgres's transient "tuple
// concurrently updated" error safe: DDL is transactional, so a failed
// attempt rolls back cleanly and a retry starts from scratch. Established
// in intake-guards.test.mjs; reused verbatim here for the same file.
function applyMigrationWithRetry(dbName, sqlText, attempts = 5) {
  const wrapped = `begin;\n${sqlText}\ncommit;\n`;
  let lastResult;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastResult = psql(dbName, wrapped);
    if (lastResult.status === 0) return lastResult.stdout;
    if (!/tuple concurrently updated/.test(lastResult.stderr || "")) break;
  }
  assert.equal(lastResult.status, 0, `psql failed against ${dbName}: ${lastResult.stderr || lastResult.stdout}`);
  return lastResult.stdout;
}

// Runs sqlText as `authenticated` with auth.uid() pinned to uuid for one
// psql invocation, mirroring what PostgREST does per-request.
function asAuthenticated(uuid, sqlText) {
  return `set role authenticated;\ndo $$ begin perform set_config('app.test_uid', '${uuid}', false); end $$;\n${sqlText}`;
}

function freshDbName() {
  return `m4_03_get_prompt_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withMigratedDb(fn) {
  const db = freshDbName();
  psqlOk("postgres", `drop database if exists ${db}; create database ${db};`);
  try {
    psqlOk(db, HARNESS_SQL);
    psqlOk(db, readFileSync(PLATFORM_BOOTSTRAP_UP, "utf8"));
    psqlOk(db, OWNER_BOOTSTRAP_SQL);
    for (const name of PO_MIGRATIONS_IN_ORDER) {
      const sql = readFileSync(join(PO_MIGRATIONS_DIR, name), "utf8");
      if (name === "20260807020000_prompt_create_prompt.sql") applyMigrationWithRetry(db, sql);
      else psqlOk(db, sql);
    }
    return fn(db);
  } finally {
    psqlOk("postgres", `drop database if exists ${db};`);
  }
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
  "real Postgres: security invoker -- a different authenticated user gets PT404, never another owner's row (no leak)",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/owner-only', 'no vars here');"));

      const stderr = callGetPromptError(db, STRANGER_UUID, "'gp/owner-only', null, null, null, null");

      assert.match(stderr, /PT404/, "RLS makes the row invisible, surfacing as the same not-found class, not a leak");
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
  "real Postgres: an unauthenticated session (authenticated role, no uid ever set) gets PT404, not a crash or a leak",
  { skip: SKIP_REASON },
  () => {
    withMigratedDb((db) => {
      psqlOk(db, asAuthenticated(OWNER_UUID, "insert into prompt.prompt (title, body) values ('gp/needs-session', 'no vars here');"));

      const result = psql(db, "set role authenticated;\nselect prompt.get_prompt('gp/needs-session', null, null, null, null);");

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /PT404/);
    });
  },
);

test("real Postgres: the down migration drops get_prompt cleanly", { skip: SKIP_REASON }, () => {
  withMigratedDb((db) => {
    psqlOk(db, readFileSync(GET_PROMPT_DOWN, "utf8"));

    const result = psql(db, "select prompt.get_prompt('anything', null, null, null, null);");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not exist/i);
  });
});
