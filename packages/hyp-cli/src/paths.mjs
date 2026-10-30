// Filesystem anchor points, resolved from this file's own location so the
// CLI behaves the same regardless of the invoking working directory (repo
// root, per the issue's "npm run tool:new -- ..." phrasing).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url)); // packages/hyp-cli/src

export const CLI_PACKAGE_ROOT = join(__dirname, "..");
export const REPO_ROOT = join(CLI_PACKAGE_ROOT, "..", "..");

// Tools live in the repo apps/ directory. A fixture root keeps its own apps/
// beneath itself, so tests never touch the real tree (see src/args.mjs's
// `--repo-root` override, mirroring packages/manifest-tools' `--root` flag).
export const appsDirOf = (repoRoot) => join(repoRoot, "apps");
