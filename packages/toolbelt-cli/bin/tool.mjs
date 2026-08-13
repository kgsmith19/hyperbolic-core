#!/usr/bin/env node
// Executable entry point for `tool:new` (docs/planning/05-c-toolbelt.md
// section 5.1). Thin process wrapper: all real logic lives in ../src/ so
// tests can call it without spawning a subprocess. This file is what the
// root `npm run tool:new` script and this package's own `bin.tool` /
// `scripts.tool:new` all invoke.
import { main } from "../src/cli.mjs";

const exitCode = main(process.argv.slice(2));
process.exitCode = exitCode;
