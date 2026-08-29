import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const sourceScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tailscale-serve-apply.sh",
);
const rootProxy = "http://127.0.0.1:8080";
const host = "node.example.ts.net";

function desiredState() {
  return {
    TCP: { 443: { HTTPS: true } },
    Web: {
      [`${host}:443`]: {
        Handlers: { "/": { Proxy: rootProxy } },
      },
    },
  };
}

function stateWithLegacy8443(pathTarget = "/home/deploy/lifeos-ui/current") {
  const state = desiredState();
  state.TCP[8443] = { HTTPS: true };
  state.Web[`${host}:8443`] = {
    Handlers: { "/": { Path: pathTarget } },
  };
  return state;
}

function classifier(status) {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-8443-classifier-"));
  try {
    const bashEnv = path.join(root, "bash-env.sh");
    writeFileSync(
      bashEnv,
      `tailscale() {\n  if [[ "$*" == "serve status --json" ]]; then\n    printf '%s' "$SERVE_STATUS"\n    return 0\n  fi\n  return 91\n}\n`,
    );
    return execFileSync(process.env.BASH_PATH ?? "bash", [sourceScript, "--classify-status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BASH_ENV: bashEnv,
        NODE_TEST_CONTEXT: "1",
        SERVE_STATUS: JSON.stringify(status),
        TAILSCALE_SERVE_TEST_ROOT: "1",
      },
    }).trim();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function applyFixture(initialState, { verifierFailsOnHttps = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-8443-apply-"));
  const script = path.join(root, "tailscale-serve-apply.sh");
  const verifier = path.join(root, "verify-private-origin.sh");
  const bashEnv = path.join(root, "bash-env.sh");
  const stateFile = path.join(root, "state.json");
  const desiredFile = path.join(root, "desired.json");
  const eventsFile = path.join(root, "events.log");

  writeFileSync(script, readFileSync(sourceScript, "utf8"));
  writeFileSync(stateFile, JSON.stringify(initialState));
  writeFileSync(desiredFile, JSON.stringify(desiredState()));
  writeFileSync(
    verifier,
    `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'verify:%s\\n' "$1" >> "$EVENTS_FILE"\nif [[ "${verifierFailsOnHttps ? "true" : "false"}" == "true" && "$1" == https://* ]]; then\n  exit 73\nfi\n`,
  );
  chmodSync(verifier, 0o755);
  writeFileSync(
    bashEnv,
    `tailscale() {
  printf 'tailscale:%s\\n' "$*" >> "$EVENTS_FILE"
  case "$*" in
    "serve status --json")
      cat "$STATE_FILE"
      ;;
    "serve --bg --yes --https=443 --set-path=/ http://127.0.0.1:8080")
      ;;
    "serve --yes --https=8443 off")
      cat "$DESIRED_FILE" > "$STATE_FILE"
      ;;
    "serve --yes --https=443 --set-path="*" off")
      ;;
    *)
      return 92
      ;;
  esac
}
curl() {
  local url="\${!#}"
  if [[ "$url" == "http://127.0.0.1:8080/healthz" ]]; then
    printf '{"status":"ok"}'
    return 0
  fi
  return 93
}
`,
  );

  const result = spawnSync(process.env.BASH_PATH ?? "bash", [script, "--apply"], {
    encoding: "utf8",
    env: {
      ...process.env,
      BASH_ENV: bashEnv,
      DESIRED_FILE: desiredFile,
      EVENTS_FILE: eventsFile,
      NODE_TEST_CONTEXT: "1",
      STATE_FILE: stateFile,
      TAILSCALE_SERVE_TEST_ROOT: "1",
    },
  });
  const events = readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean);
  const finalState = JSON.parse(readFileSync(stateFile, "utf8"));
  rmSync(root, { recursive: true, force: true });
  return { events, finalState, result };
}

test("a correct 443 gateway plus the legacy LifeOS 8443 listener is not classified as converged", () => {
  assert.equal(classifier(stateWithLegacy8443()), "legacy");
});

test("the exact 443-only gateway is classified as converged", () => {
  assert.equal(classifier(desiredState()), "gateway");
});

test("apply verifies live 443 before retiring the documented legacy 8443 listener", () => {
  const { events, finalState, result } = applyFixture(stateWithLegacy8443());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(finalState, desiredState());

  const liveVerify = events.indexOf(`verify:https://${host}`);
  const retirement = events.indexOf("tailscale:serve --yes --https=8443 off");
  assert.notEqual(liveVerify, -1, events.join("\n"));
  assert.notEqual(retirement, -1, events.join("\n"));
  assert.ok(liveVerify < retirement, events.join("\n"));
});

test("a failed live 443 verification preserves the legacy 8443 listener", () => {
  const { events, finalState, result } = applyFixture(stateWithLegacy8443(), {
    verifierFailsOnHttps: true,
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(finalState, stateWithLegacy8443());
  assert.equal(events.includes("tailscale:serve --yes --https=8443 off"), false);
});

test("rerunning an already-converged 443-only gateway is idempotent", () => {
  const { events, finalState, result } = applyFixture(desiredState());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(finalState, desiredState());
  assert.equal(events.includes("tailscale:serve --yes --https=8443 off"), false);
});

for (const [label, mutate] of [
  ["unknown HTTPS port", (state) => {
    state.TCP[9443] = { HTTPS: true };
    state.Web[`${host}:9443`] = { Handlers: { "/": { Path: "/srv/unknown" } } };
  }],
  ["unrecognized 8443 target", (state) => {
    state.TCP[8443] = { HTTPS: true };
    state.Web[`${host}:8443`] = { Handlers: { "/": { Path: "/srv/not-lifeos" } } };
  }],
]) {
  test(`${label} fails before any Serve write`, () => {
    const state = desiredState();
    mutate(state);
    const { events, finalState, result } = applyFixture(state);
    assert.notEqual(result.status, 0);
    assert.deepEqual(finalState, state);
    assert.equal(
      events.some((entry) => entry.startsWith("tailscale:serve --bg") || entry.includes(" off")),
      false,
      events.join("\n"),
    );
  });
}

test("the documented standalone dist path is recognized as the same retireable legacy listener", () => {
  const { finalState, result } = applyFixture(stateWithLegacy8443("/home/deploy/lifeos-ui/dist"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(finalState, desiredState());
});
