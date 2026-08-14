// `node --test <bare-directory>` does not recurse into the directory: the
// Node.js test runner only auto-discovers files for a *glob pattern* or for
// zero-argument discovery, not for a literal directory path passed as a CLI
// argument (see the Node.js test runner docs, "Test runner execution model").
// A bare directory argument instead falls through to ordinary module
// resolution, which *does* fall back to `<directory>/index.js`.
//
// This file exists purely so that `node --test packages/platform-client/tests/`
// (the exact command this package is verified with) still finds and runs
// every test below, by loading them as a side effect.
import "./platform-client.test.ts";
import "./registry.test.ts";
import "./brain.test.ts";
import "./cost.test.ts";
