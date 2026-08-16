# @hyperbolic/toolbelt-cli

Scaffold CLI for the Toolbelt 3-step new-tool lifecycle (TB-3,
`docs/planning/05-c-toolbelt.md` section 5.1): generates
`apps/toolbelt/apps/<id>/` from validated flags, or prints the plan with
`--dry-run`.

Node >= 22, ESM. Depends on `ajv` / `ajv-formats` for manifest schema
validation.

## Usage

Invoked through the root workspace script, or `npx tool` where
`@hyperbolic/toolbelt-cli` is a dependency:

```bash
npm run tool:new -- --id my-tool --name "My Tool" --kind ui --route /my-tool
```

```
Usage: npm run tool:new -- --id <tool-id> --name <display-name> --kind ui|cli|headless|hybrid
                           [--schema <schema-name>]   default: <tool-id> with - replaced by _
                           [--route /<path>]          required when kind is ui|hybrid
                           [--no-schema]              tool owns no database schema
                           [--llm]                    sets permissions.llmHandler.access = true
                           [--dry-run]                print the plan, write nothing

Exit codes: 0 generated; 2 validation failure (id taken in core.app or on disk,
schema collision across manifests, bad flag combination); no partial writes on failure.
```

`bin/tool.mjs` is the thin process wrapper (`process.argv` / exit code) that
the `tool` bin and the `tool:new` script both invoke; `src/cli.mjs`'s `main`
does the real work and is what tests call directly.

## Layout

```
bin/tool.mjs               executable entry point
src/cli.mjs                 main(argv, io?) — parse, validate, scaffold, report
src/args.mjs                 parseArgs/validateOptions, USAGE text, id/schema/route patterns
src/scaffold.mjs             runScaffold/writePlan — generates files, rolls back on I/O failure
src/collisions.mjs           id/schema collision checks against core.app and on-disk manifests
src/manifests-shared.mjs     manifest fields shared across generated tool kinds
src/templates.mjs            file templates for each generated tool
src/paths.mjs                 DEFAULT_TOOLBELT_ROOT and path helpers
src/timestamp.mjs            migration-filename timestamp generation
```

## Documentation

`docs/planning/05-c-toolbelt.md` section 5.1 specifies the 3-step lifecycle
this CLI implements. A successful non-dry-run generates a manifest but does
not itself register the tool live: the CLI prints a reminder to run
`npm run migrations:check --prefix apps/toolbelt` and apply the ledger
through `platform-migrations.yml`.
