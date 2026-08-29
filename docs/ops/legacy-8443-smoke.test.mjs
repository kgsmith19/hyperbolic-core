import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/platform-smoke.yml"), "utf8");

test("post-deploy smoke treats any responding legacy LifeOS 8443 HTTPS listener as a failure", () => {
  assert.match(workflow, /probe_closed_https_listener\(\)/);
  assert.match(
    workflow,
    /local legacy_origin="https:\/\/\$DEPLOY_HOST:\$port"[\s\S]*curl --insecure[\s\S]*"\$legacy_origin\/"/,
  );
  assert.match(workflow, /retired HTTPS listener still accepted a request/);
  assert.match(
    workflow,
    /if \[\[ "\$\{LIFEOS_LIVE:-\}" == "true" \]\]; then[\s\S]*probe_closed_https_listener "Legacy LifeOS HTTPS listener" "8443"/,
  );
});

test("the 8443 negative control is additive to the existing portless LifeOS probes", () => {
  for (const route of ["/life/", "/life/capture", "/life/api/healthz"]) {
    assert.ok(workflow.includes(`"${route}"`), `missing existing portless probe ${route}`);
  }
});
