import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const here = import.meta.dirname;
const pkg: unknown = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));

/**
 * Finding #72 (PR #8 security review): package.json previously had no
 * "version" field at all, so `pkg.version` was `undefined` and
 * `JSON.stringify(undefined)` evaluated to the literal JS `undefined` (not
 * a string) -- the old `as { version: string }` cast hid that from tsc, and
 * it flowed unguarded into `define: { __APP_VERSION__: ... }`, rendering
 * "Shell vundefined" in Settings (src/pages/settings.tsx via
 * src/lib/build-info.ts). Failing the BUILD loudly here is deliberately
 * more defensive than a silent `?? "0.0.0-dev"` fallback: a missing/renamed
 * version field is almost certainly a packaging mistake, not a state this
 * build should quietly paper over and ship anyway.
 */
function resolvePackageVersion(value: unknown): string {
  const version = (value as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      `apps/shell/package.json is missing a valid "version" string field (got: ${JSON.stringify(version)}). ` +
        'Settings renders this as "Shell v{APP_VERSION}" -- see src/lib/build-info.ts and src/pages/settings.tsx.'
    );
  }
  return version;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: here, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

// Settings page "Version/build info per zone" (05-a section 8). Baked in at
// build time so the running app never needs a server round-trip just to
// report what it is -- see src/vite-env.d.ts for the ambient declarations
// and src/lib/build-info.ts for the typed re-export.
const APP_VERSION = JSON.stringify(resolvePackageVersion(pkg));
const BUILD_SHA = JSON.stringify(gitSha());
const BUILD_TIME = JSON.stringify(new Date().toISOString());

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(here, "src") } },
  define: {
    __APP_VERSION__: APP_VERSION,
    __BUILD_SHA__: BUILD_SHA,
    __BUILD_TIME__: BUILD_TIME,
  },
  server: {
    // Explicit IPv4 host, matching apps/agentic-command-center/frontend/vite.config.ts's
    // own comment: Vite's default (host: false) binds the ambiguous
    // "localhost", which some environments resolve to the IPv6 loopback
    // only, breaking 127.0.0.1-based health checks even though Vite reports
    // "ready".
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
