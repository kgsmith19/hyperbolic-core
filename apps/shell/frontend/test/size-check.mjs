#!/usr/bin/env node
// Size-check gate for apps/shell (docs/planning/09-design-system.md
// section 6: "Shell initial JS (entry + shared chunks to first render):
// 250 KB gz ... size script in CI over apps/shell/frontend/dist").
//
// This measures the REAL production build output, not a probe bundle
// (unlike packages/ui/test/size-check.mjs, which builds a synthetic probe
// of its own public entry because packages/ui is a library with no dist/
// app shell of its own). apps/shell IS the deployable app, so its own real
// `npm run build` output is exactly what a browser downloads on first load
// -- measuring that directly is strictly more honest than reconstructing it.
//
// "entry + shared chunks to first render" is read literally: only the JS
// files dist/index.html itself references for the initial load (its
// <script type=module> entry plus any <link rel=modulepreload> chunks) are
// counted. A future route that code-splits via React.lazy() would emit a
// chunk NOT referenced by index.html directly (only pulled in on
// navigation), correctly excluded from this budget the same way 09 section 6
// treats "any route chunk" as a separate, looser 100 KB-per-chunk budget,
// not part of this number. apps/shell does not lazy-load routes today, so
// in practice this currently covers the app's entire JS output.
//
// KB here means 1024 bytes (KiB), matching packages/ui/test/size-check.mjs's
// own convention note.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const distDir = path.join(appRoot, "dist");
const indexHtmlPath = path.join(distDir, "index.html");
const BUDGET_BYTES = 250 * 1024; // 250 KB gzipped

function fmtKb(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function extractInitialJsPaths(html) {
  const paths = new Set();
  // <script type="module" src="/assets/xyz.js">
  for (const m of html.matchAll(/<script[^>]+type=["']module["'][^>]*\ssrc=["']([^"']+)["'][^>]*>/gi)) {
    paths.add(m[1]);
  }
  // <link rel="modulepreload" href="/assets/xyz.js">
  for (const m of html.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]*\shref=["']([^"']+)["'][^>]*>/gi)) {
    paths.add(m[1]);
  }
  return [...paths].filter((p) => p.endsWith(".js"));
}

async function main() {
  if (process.env.NODE_TEST_CONTEXT) {
    // Same guard as packages/ui/test/size-check.mjs: never let an unrelated
    // `node --test` sweep of this directory trigger this script as a side
    // effect (this file lives under `test/`, which node:test auto-discovers).
    return;
  }

  if (!existsSync(indexHtmlPath)) {
    console.error(
      `[size-check] ${path.relative(appRoot, indexHtmlPath)} does not exist -- run \`npm run build\` first.`
    );
    process.exitCode = 1;
    return;
  }

  const html = readFileSync(indexHtmlPath, "utf8");
  const jsPaths = extractInitialJsPaths(html);

  if (jsPaths.length === 0) {
    console.error(`[size-check] found no initial JS <script type=module>/<link modulepreload> tags in ${indexHtmlPath}`);
    process.exitCode = 1;
    return;
  }

  let totalGzipBytes = 0;
  const measured = [];

  for (const jsPath of jsPaths) {
    // dist/index.html references built assets with absolute paths
    // (base: "/"); strip the leading slash to resolve against distDir.
    const relPath = jsPath.replace(/^\/+/, "");
    const filePath = path.join(distDir, relPath);
    if (!existsSync(filePath)) {
      console.error(`[size-check] index.html references ${jsPath}, but ${filePath} does not exist.`);
      process.exitCode = 1;
      return;
    }
    const content = readFileSync(filePath);
    const gz = gzipSync(content, { level: 9 });
    totalGzipBytes += gz.length;
    measured.push({ file: relPath, raw: content.length, gzip: gz.length });
  }

  console.log("[size-check] apps/shell/frontend/dist initial JS (entry + modulepreload chunks referenced by index.html):");
  for (const m of measured) {
    console.log(`  ${m.file.padEnd(32)} raw ${fmtKb(m.raw).padStart(10)}  gzip ${fmtKb(m.gzip).padStart(10)}`);
  }
  console.log(`[size-check] total gzipped: ${fmtKb(totalGzipBytes)} / budget ${fmtKb(BUDGET_BYTES)}`);

  if (totalGzipBytes > BUDGET_BYTES) {
    console.error(
      `[size-check] FAIL: ${fmtKb(totalGzipBytes)} exceeds the ${fmtKb(BUDGET_BYTES)} budget by ${fmtKb(
        totalGzipBytes - BUDGET_BYTES
      )}.`
    );
    process.exitCode = 1;
    return;
  }

  console.log("[size-check] PASS");
}

main().catch((err) => {
  console.error("[size-check] failed:", err);
  process.exitCode = 1;
});
