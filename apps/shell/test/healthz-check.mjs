#!/usr/bin/env node
// Healthz build-output check for apps/shell (docs/planning/issues/m2-04-feat-shell-serve-routes.md,
// SH-5: docs/planning/05-a-hyperbolic-core.md section 12).
//
// SH-5's verification command is a BARE curl against the deployed origin
// with no JS execution: `curl -s -o /dev/null -w '%{http_code}'
// https://<origin>/healthz` must print 200. A client-side-only route
// registered in apps/shell/src/app.tsx (e.g. a react-router
// <Route path="/healthz">) would NOT satisfy this: react-router only
// intercepts navigation after the SPA's own JS bundle has already loaded
// and run, which a bare curl never does. Worse, most static hosts serving
// an SPA (including Vite's own `preview` server, used below and by this
// app's real e2e suite -- see playwright.config.ts's webServer) fall back
// to serving index.html with status 200 for ANY unmatched path, so a naive
// "curl /healthz returns 200" check can pass even when nothing was built
// for /healthz specifically -- it would just be catching the same SPA
// shell every other nonexistent path also gets. This script proves the
// stronger property: /healthz is real bytes on disk in dist/ (copied
// verbatim from apps/shell/public/healthz by Vite's public-dir handling),
// served with a body and Content-Type that are OBSERVABLY DIFFERENT from
// the SPA fallback an unmapped path receives.
//
// This does not rebuild apps/shell -- run `npm run build` first, same
// convention as test/size-check.mjs. It spins up the exact server this
// app's own Playwright e2e suite uses (`vite preview`) against that
// pre-built dist/, so the assertions below exercise the real
// static-file-serving code path a production deploy uses, not a
// hand-rolled substitute.

import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const distDir = path.join(appRoot, "dist");
const healthzSourcePath = path.join(appRoot, "public", "healthz");
const healthzDistPath = path.join(distDir, "healthz");
// Deliberately distinct from playwright.config.ts's 4173 so this script can
// run alongside (or independently of) the Playwright webServer without a
// port clash.
const PORT = 41897;
const BASE = `http://127.0.0.1:${PORT}`;

let ok = true;
function fail(msg) {
  console.error(`[healthz-check] FAIL: ${msg}`);
  ok = false;
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`server at ${url} never became reachable within ${timeoutMs}ms (${lastErr?.message ?? "no response"})`);
}

async function main() {
  if (process.env.NODE_TEST_CONTEXT) {
    // Same guard as test/size-check.mjs: this file lives under test/, which
    // node:test auto-discovers -- never let an unrelated `node --test`
    // sweep of this directory spawn a real preview server as a side effect.
    return;
  }

  if (!existsSync(healthzSourcePath)) {
    fail("apps/shell/public/healthz does not exist -- the source asset SH-5 requires is missing.");
    process.exitCode = 1;
    return;
  }

  if (!existsSync(distDir) || !existsSync(healthzDistPath)) {
    fail(
      `${path.relative(appRoot, healthzDistPath)} does not exist -- run \`npm run build\` first. ` +
        "Vite copies public/ verbatim to dist/'s root; a missing dist/healthz after a real build " +
        "would mean the public/ directory isn't being picked up, which is itself worth investigating."
    );
    process.exitCode = 1;
    return;
  }

  const expectedBody = readFileSync(healthzSourcePath, "utf8");

  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: appRoot,
    stdio: "ignore",
  });
  const serverDied = new Promise((_, reject) => {
    server.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        reject(new Error(`vite preview exited early with code ${code} (signal ${signal ?? "none"})`));
      }
    });
    server.on("error", reject);
  });

  try {
    await Promise.race([waitForServer(`${BASE}/`, 20_000), serverDied]);

    const healthzRes = await fetch(`${BASE}/healthz`);
    const healthzBody = await healthzRes.text();
    const healthzContentType = healthzRes.headers.get("content-type") ?? "";

    if (healthzRes.status !== 200) {
      fail(`GET /healthz returned ${healthzRes.status}, expected 200.`);
    } else if (healthzBody !== expectedBody) {
      fail(
        "GET /healthz body did not match apps/shell/public/healthz's source content -- something " +
          "other than the real static asset answered this request (most likely the SPA index.html fallback)."
      );
    } else if (healthzContentType.startsWith("text/html")) {
      fail(
        `GET /healthz responded with Content-Type "${healthzContentType}", which is what the SPA's ` +
          "index.html fallback returns, not a real static asset. A client-side <Route path=\"/healthz\"> " +
          "does NOT satisfy SH-5 -- see this file's header comment for why."
      );
    } else {
      console.log(
        `[healthz-check] GET /healthz -> 200, Content-Type "${healthzContentType}", body matches public/healthz. PASS`
      );
    }

    // Control case: prove /healthz is not just riding the same "any path
    // returns 200" SPA fallback every unmapped path gets under Vite
    // preview's default appType "spa" behavior (which mirrors how a real
    // static host is typically configured for an SPA). If this control case
    // is indistinguishable from /healthz, a bare 200 status code alone
    // would not have been a meaningful health signal.
    const bogusRes = await fetch(`${BASE}/definitely-not-a-real-route-${Date.now()}`);
    const bogusBody = await bogusRes.text();
    if (bogusBody === expectedBody) {
      fail(
        "An unmapped path returned the exact same body as /healthz -- healthz is not actually " +
          "distinguishable from the SPA fallback, defeating the point of a dedicated health route."
      );
    } else {
      console.log(
        "[healthz-check] control case: an unmapped path answers with the SPA shell (a different " +
          "body from /healthz), confirming /healthz is a real, distinct static asset. PASS"
      );
    }
  } finally {
    server.kill();
  }

  if (ok) {
    console.log("[healthz-check] PASS");
  } else {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[healthz-check] failed:", err);
  process.exitCode = 1;
});
