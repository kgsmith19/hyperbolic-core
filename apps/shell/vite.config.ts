import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const here = import.meta.dirname;
const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")) as {
  version: string;
};

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
const APP_VERSION = JSON.stringify(pkg.version);
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
    // Explicit IPv4 host, matching apps/agentic-command-center/ui/vite.config.ts's
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
