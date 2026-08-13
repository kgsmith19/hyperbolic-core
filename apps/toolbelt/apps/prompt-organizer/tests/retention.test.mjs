import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asAuthenticated,
  createPostgresHarness,
  supabaseHarnessSql,
} from "./postgres-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rootMigrations = join(here, "..", "..", "..", "supabase", "migrations");
const migrations = join(here, "..", "supabase", "migrations");
const platformBootstrap = join(rootMigrations, "20260812140000_platform_owner_bootstrap.sql");
const retentionUp = join(migrations, "20260812210000_prompt_usage_retention.sql");
const getPromptUp = join(migrations, "20260813120000_prompt_create_get_prompt_function.sql");
const securityHardeningUp = join(migrations, "20260813140000_prompt_security_hardening.sql");
const revokePublicUp = join(migrations, "20260814030000_prompt_purge_old_usage_revoke_public.sql");
const hardeningUp = join(migrations, "20260814121000_prompt_purge_old_usage_hardening.sql");
const hardeningDown = join(migrations, "20260814121000_prompt_purge_old_usage_hardening_down.sql");

const baseMigrations = [
  "20260807020000_prompt_create_prompt.sql",
  "20260807041000_prompt_versions_and_unique_title.sql",
  "20260807051000_prompt_create_tag.sql",
  "20260807070000_prompt_create_usage.sql",
  "20260808000000_prompt_add_is_active.sql",
  "20260808100000_prompt_create_configuration.sql",
  "20260808130000_prompt_create_render_function.sql",
  "20260812180000_prompt_owner_pin.sql",
  "20260812200000_prompt_observed_query_indexes.sql",
];

const OWNER_UUID = "9a50a35a-8a1e-4f0c-8495-7f26777982d8";
const PG = createPostgresHarness("prompt_retention_test");
const { psql, psqlOk, applyMigrationWithRetry } = PG;

// Bare PostgreSQL does not ship pg_cron. The migration only needs its two
// registration functions; retention behavior itself is ordinary PostgreSQL.
const CRON_HARNESS_SQL = `
create schema cron;
create table cron.job (jobid bigint generated always as identity, jobname text unique not null);
create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint
language plpgsql as $$
declare v_id bigint;
begin
  insert into cron.job (jobname) values (p_name) returning jobid into v_id;
  return v_id;
end
$$;
create function cron.unschedule(p_name text) returns boolean
language plpgsql as $$
begin
  delete from cron.job where jobname = p_name;
  return found;
end
$$;
`;

function buildDatabase(db) {
  psqlOk(db, supabaseHarnessSql([OWNER_UUID]));
  psqlOk(db, readFileSync(platformBootstrap, "utf8"));
  psqlOk(db, `insert into platform.config (owner_uuid) values ('${OWNER_UUID}');`);
  psqlOk(db, CRON_HARNESS_SQL);
  for (const name of baseMigrations) {
    const migration = readFileSync(join(migrations, name), "utf8");
    if (name === "20260807020000_prompt_create_prompt.sql") applyMigrationWithRetry(db, migration);
    else psqlOk(db, migration);
  }
  psqlOk(db, readFileSync(retentionUp, "utf8"));
  psqlOk(db, readFileSync(getPromptUp, "utf8"));
  psqlOk(db, readFileSync(securityHardeningUp, "utf8"));
  psqlOk(db, readFileSync(revokePublicUp, "utf8"));
  psqlOk(db, readFileSync(hardeningUp, "utf8"));
}

test("real Postgres: purge_old_usage is executable by its cron owner and no API role", { skip: PG.skipReason }, () => {
  PG.withDatabase((db) => {
    buildDatabase(db);

    const privileges = psqlOk(
      db,
      `select rolname || '|' || has_function_privilege(rolname, 'prompt.purge_old_usage()', 'execute')
       from pg_roles
       where rolname in ('anon', 'authenticated', 'service_role', 'prompt_get_agent')
       order by rolname;`,
    )
      .trim()
      .split("\n");
    assert.deepEqual(privileges, [
      "anon|false",
      "authenticated|false",
      "prompt_get_agent|false",
      "service_role|false",
    ]);

    for (const role of ["anon", "authenticated", "service_role", "prompt_get_agent"]) {
      const denied = psql(db, `set role ${role}; select prompt.purge_old_usage();`);
      assert.notEqual(denied.status, 0, `${role} unexpectedly executed the cron-only function`);
      assert.match(denied.stderr, /permission denied/i);
    }

    assert.equal(psqlOk(db, "select prompt.purge_old_usage();").trim(), "0");
  });
});

test("real Postgres: purge counts and aggregates only the rows it deletes", { skip: PG.skipReason }, () => {
  PG.withDatabase((db) => {
    buildDatabase(db);
    psqlOk(
      db,
      asAuthenticated(
        OWNER_UUID,
        `insert into prompt.prompt (title, body) values ('retention/fixture', 'body') returning id \\gset
         insert into prompt.usage (prompt_id, version_no, created_at) values
           (:'id', 1, now() - interval '500 days'),
           (:'id', 1, now() - interval '400 days'),
           (:'id', 1, now() - interval '10 days');`,
      ),
    );

    assert.equal(psqlOk(db, "select prompt.purge_old_usage();").trim(), "2");
    assert.equal(psqlOk(db, "select count(*) from prompt.usage;").trim(), "1", "recent usage must remain hot");
    assert.equal(
      psqlOk(db, "select sum(copy_count) from prompt.usage_monthly_agg;").trim(),
      "2",
      "each deleted row must be aggregated once",
    );

    assert.equal(psqlOk(db, "select prompt.purge_old_usage();").trim(), "0");
    assert.equal(
      psqlOk(db, "select sum(copy_count) from prompt.usage_monthly_agg;").trim(),
      "2",
      "an empty follow-up purge must not inflate history",
    );
  });
});

test("real Postgres: the atomicity down migration preserves the prior API-execution revocation", { skip: PG.skipReason }, () => {
  PG.withDatabase((db) => {
    buildDatabase(db);
    psqlOk(db, readFileSync(hardeningDown, "utf8"));

    const result = psql(db, "set role authenticated; select prompt.purge_old_usage();");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /permission denied/i);
  });
});
