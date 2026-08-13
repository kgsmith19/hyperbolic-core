#!/usr/bin/env node
// Size-check gate for packages/ui.
//
// Bundles a probe build of the full public entry (src/index.ts) the same
// way a consuming app's bundler would: react/react-dom (peer deps every
// consumer already pays for once) are externalized, and everything else
// packages/ui actually depends on -- Base UI, CVA, clsx, tailwind-merge,
// lucide-react, ... -- is included for real, minified, and gzipped. The
// total must be at most 60 KB gzipped: the "packages/ui contribution to
// any consumer" budget in docs/planning/09-design-system.md section 6.
//
// Exit 0: under budget, OR there is no public entry yet to measure
//   (packages/ui/src/index.ts does not exist -- true during m1-03, before
//   m1-04 adds src/index.ts and the primitives it exports).
// Exit 1: over budget, or the probe bundle failed to build.
//
// KB here means 1024 bytes (KiB), matching common frontend size-budget
// tooling (size-limit, webpack-bundle-analyzer, etc.), not 1000 bytes.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");
const entryPath = path.join(pkgRoot, "src", "index.ts");
const BUDGET_BYTES = 60 * 1024; // 60 KB gzipped

function fmtKb(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

async function main() {
  // node's test runner auto-discovers every .{js,mjs,cjs} file that lives
  // under a directory literally named "test" -- including this one, since
  // it must live at exactly this path per the design-system spec. When
  // node:test loads a file (whether via `node --test` with no args, an
  // explicit directory, or a glob), it sets NODE_TEST_CONTEXT in that
  // child process; a direct `node test/size-check.mjs` invocation never
  // sets it. Skip the probe build in the former case so this gate script
  // never turns into a slow, silently-swallowed side effect of an
  // unrelated `node --test` run.
  if (process.env.NODE_TEST_CONTEXT) {
    return;
  }

  if (!existsSync(entryPath)) {
    console.log(
      `[size-check] no public entry yet at ${path.relative(pkgRoot, entryPath)} -- ` +
        `nothing to measure, 0.00 KB gzipped (budget ${fmtKb(BUDGET_BYTES)}). PASS.`
    );
    return;
  }

  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;

  const result = await build({
    root: pkgRoot,
    configFile: false,
    logLevel: "warn",
    plugins: [react()],
    build: {
      write: false,
      // Use Vite's own default minifier rather than forcing one: this repo's
      // Vite 8 does not have the `esbuild` package installed standalone
      // (esbuild-based minification is opt-in there, not the default), and
      // packages/ui's own vite.config.ts build (which this probe mirrors)
      // already relies on the default successfully.
      sourcemap: false,
      lib: {
        entry: entryPath,
        // CJS, matching packages/ui's own vite.config.ts -- see the format
        // note there (Rolldown's ESM external-require interop currently
        // breaks on a nested CJS dependency; CJS output has no such gap).
        formats: ["cjs"],
        fileName: () => "probe.cjs",
      },
      rollupOptions: {
        // Peer deps: every consumer already pays for these once, so they
        // do not count against packages/ui's own contribution. Everything
        // else packages/ui depends on is real, counted weight.
        external: [/^react($|\/)/, /^react-dom($|\/)/],
      },
    },
  });

  const outputs = Array.isArray(result) ? result : [result];
  let totalGzipBytes = 0;
  const measured = [];

  for (const out of outputs) {
    for (const chunkOrAsset of out.output) {
      const content =
        chunkOrAsset.type === "chunk" ? chunkOrAsset.code : chunkOrAsset.source;
      const rawBytes = Buffer.byteLength(content);
      const gz = gzipSync(content, { level: 9 });
      totalGzipBytes += gz.length;
      measured.push({ file: chunkOrAsset.fileName, raw: rawBytes, gzip: gz.length });
    }
  }

  console.log("[size-check] probe build of packages/ui/src/index.ts:");
  for (const m of measured) {
    console.log(
      `  ${m.file.padEnd(24)} raw ${fmtKb(m.raw).padStart(10)}  gzip ${fmtKb(m.gzip).padStart(10)}`
    );
  }
  console.log(
    `[size-check] total gzipped: ${fmtKb(totalGzipBytes)} / budget ${fmtKb(BUDGET_BYTES)}`
  );

  if (totalGzipBytes > BUDGET_BYTES) {
    console.error(
      `[size-check] FAIL: ${fmtKb(totalGzipBytes)} exceeds the ${fmtKb(BUDGET_BYTES)} budget ` +
        `by ${fmtKb(totalGzipBytes - BUDGET_BYTES)}.`
    );
    process.exitCode = 1;
    return;
  }

  console.log("[size-check] PASS");
}

main().catch((err) => {
  console.error("[size-check] probe build failed:", err);
  process.exitCode = 1;
});
