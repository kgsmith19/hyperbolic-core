import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tailscale-serve-apply.sh",
);

test("a correct 443 gateway plus the legacy LifeOS 8443 listener is not classified as converged", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-8443-red-"));
  try {
    const bashEnv = path.join(root, "bash-env.sh");
    const state = JSON.stringify({
      TCP: {
        443: { HTTPS: true },
        8443: { HTTPS: true },
      },
      Web: {
        "node.example.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:8080" },
          },
        },
        "node.example.ts.net:8443": {
          Handlers: {
            "/": { Path: "/home/deploy/lifeos-ui/current" },
          },
        },
      },
    });

    writeFileSync(
      bashEnv,
      `tailscale() {\n  if [[ "$*" == "serve status --json" ]]; then\n    printf '%s' "$LEGACY_8443_STATUS"\n    return 0\n  fi\n  return 91\n}\n`,
    );

    const output = execFileSync("bash", [script, "--classify-status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BASH_ENV: bashEnv,
        LEGACY_8443_STATUS: state,
        TAILSCALE_SERVE_TEST_ROOT: "1",
      },
    });

    assert.equal(output.trim(), "legacy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
