// Filesystem anchor points, resolved from this file's own location so the
// CLI behaves the same regardless of the invoking working directory (repo
// root or apps/toolbelt/, per the issue's "npm run tool:new -- ... at the
// repo root or apps/toolbelt root" phrasing).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url)); // packages/toolbelt-cli/src

export const CLI_PACKAGE_ROOT = join(__dirname, "..");
export const REPO_ROOT = join(CLI_PACKAGE_ROOT, "..", "..");

// Real toolbelt root. Production runs (bin/tool.mjs with no override) always
// use this. Tests pass an explicit fixture root instead of touching it, and
// the CLI itself accepts an undocumented `--toolbelt-root <dir>` override for
// end-to-end fixture testing (see src/args.mjs), mirroring
// apps/toolbelt/scripts/validate-manifests.mjs's own `--root` flag and its
// documented reason: "so a fixture tree can be validated end-to-end ...
// without touching real files."
export const DEFAULT_TOOLBELT_ROOT = join(REPO_ROOT, "apps", "toolbelt");
