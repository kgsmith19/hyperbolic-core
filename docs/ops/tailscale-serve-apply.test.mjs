import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "tailscale-serve-apply.sh");
const bash = process.env.BASH_PATH;
const temporaryDirectories = [];
const serveHost = "node.example.ts.net:443";
const rootProxy = "http://127.0.0.1:8080";
const rootCommand = `serve --bg --yes --https=443 --set-path=/ ${rootProxy}`;
const legacyMounts = ["/life/", "/life/api/", "/api/", "/api/brain/"];
const removalCommands = legacyMounts.map(
  (mount) => `serve --yes --https=443 --set-path=${mount} off`,
);

const legacyState = {
  TCP: { 443: { HTTPS: true } },
  Web: {
    [serveHost]: {
      Handlers: {
        "/": { Path: "/home/deploy/shell/current" },
        "/life/": { Path: "/home/deploy/lifeos-ui/current" },
        "/life/api/": { Proxy: "http://127.0.0.1:8000" },
        "/api/": { Proxy: "http://127.0.0.1:8200" },
        "/api/brain/": { Proxy: "http://127.0.0.1:8100" },
      },
    },
  },
};
const desiredState = {
  TCP: { 443: { HTTPS: true } },
  Web: {
    [serveHost]: {
      Handlers: {
        "/": { Proxy: rootProxy },
      },
    },
  },
};
const legacyStatus = JSON.stringify(legacyState, null, 2);
const desiredStatus = JSON.stringify(desiredState, null, 2);

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function shellPath(value) {
  if (!bash) return value;
  return value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function commandArgs(args) {
  return bash ? [bash, [script, ...args]] : [script, args];
}

function run(...args) {
  const [command, commandArguments] = commandArgs(args);
  return execFileSync(command, commandArguments, { encoding: "utf8" }).trim();
}

function spawn(args, options = {}) {
  const [command, commandArguments] = commandArgs(args);
  return spawnSync(command, commandArguments, { encoding: "utf8", ...options });
}

function applyFixture({
  failAt = "",
  failHealth = false,
  failRoute = "",
  finalStatus = desiredStatus,
  healthBody = '{"status":"ok"}',
  humanStatus = "this human format is deliberately not parseable",
  initialStatus = legacyStatus,
  mode = "--apply",
  responseScenario = "ok",
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "tailscale-serve-apply-"));
  temporaryDirectories.push(root);
  const bashEnv = path.join(root, "bash-env.sh");
  const log = path.join(root, "tailscale.log");
  const curlLog = path.join(root, "curl.log");
  const statusCount = path.join(root, "status-count");
  writeFileSync(
    bashEnv,
    `tailscale() {
  printf '%s\\n' "$*" >> "$TAILSCALE_TEST_LOG"
  case "$*" in
    "serve status --json")
      local count=0
      if [[ -f "$TAILSCALE_STATUS_COUNT" ]]; then
        read -r count < "$TAILSCALE_STATUS_COUNT"
      fi
      count=$((count + 1))
      printf '%s\\n' "$count" > "$TAILSCALE_STATUS_COUNT"
      if [[ "\${TAILSCALE_FAIL_AT:-}" == "initial-status" && "$count" -eq 1 ]]; then
        return 90
      fi
      if [[ "\${TAILSCALE_FAIL_AT:-}" == "final-status" && "$count" -gt 1 ]]; then
        return 91
      fi
      if [[ "$count" -eq 1 ]]; then
        printf '%s' "$TAILSCALE_INITIAL_STATUS"
      else
        printf '%s' "$TAILSCALE_FINAL_STATUS"
      fi
      ;;
    "serve status")
      printf '%s\\n' "$TAILSCALE_HUMAN_STATUS"
      return 96
      ;;
    "serve --bg --yes --https=443 --set-path=/ http://127.0.0.1:8080")
      if [[ "\${TAILSCALE_FAIL_AT:-}" == "root" ]]; then
        return 94
      fi
      ;;
    "serve --yes --https=443 --set-path="*" off")
      local mount="\${4#--set-path=}"
      if [[ "\${TAILSCALE_FAIL_AT:-}" == "remove:$mount" ]]; then
        printf 'injected removal failure for %s\n' "$mount" >&2
        return 95
      fi
      ;;
  esac
}
curl() {
  local url="\${!#}"
  local output_file=""
  local write_out=false
  local body="ok"
  local content_type="text/plain"
  local status=200
  printf '%s\\n' "$url" >> "$TAILSCALE_CURL_LOG"
  while (( $# > 0 )); do
    case "$1" in
      -o | --output)
        output_file="$2"
        shift 2
        ;;
      -w | --write-out)
        write_out=true
        shift 2
        ;;
      *) shift ;;
    esac
  done
  if [[ -n "\${TAILSCALE_FAIL_ROUTE:-}" && "$url" == "$TAILSCALE_FAIL_ROUTE" ]]; then
    return 1
  fi
  if [[ "$url" == *"/%2Fapi/%2e%2e/settings" || "$url" == *"//api/../settings" || "$url" == *"/./assets/../settings" || "$url" == *"/%2Flife/api/%2e%2e/capture" || "$url" == *"//life/api/../capture" || "$url" == *"/./life/assets/../capture" || "$url" == *"/%2F%61pi/%2e%2e/settings" || "$url" == *"//assets/../settings" || "$url" == *"/./%2E/%61ssets/%2e%2E/settings" || "$url" == *"/%2Flife/%61pi/%2e%2e/capture" || "$url" == *"//%6Cife/assets/../capture" || "$url" == *"/./life/%2E/%61pi/%2e%2e/capture" || "$url" == *"/%2E/%6cife/%2F%61ssets/%2e%2E/capture" || "$url" == *"/foo/../api/../settings" || "$url" == *"/%66oo/%2e%2e/%61pi/%2e%2e/settings" || "$url" == *"//foo/../api/../settings" || "$url" == *"/%2Ffoo/%2e%2e/api/%2e%2e/settings" || "$url" == *"/life/foo/../assets/../capture" || "$url" == *"/life/%66oo/%2e%2e/%61ssets/%2e%2e/capture" || "$url" == *"/alpha/beta/../../api/v1/../../settings" || "$url" == *"/life/one/two/../../assets/v1/../../capture" || "$url" == *"/%41pi/%2e%2e/settings" || "$url" == *"/%41%50%49/%2e%2e/settings" || "$url" == *"/%61%50i/%2e%2e/settings" || "$url" == *"/%41ssets/../settings" || "$url" == *"/%41%53%53%45%54%53/%2e%2e/settings" || "$url" == *"/%61%53s%65%54%73/%2e%2e/settings" || "$url" == *"/life/%41ssets/../capture" || "$url" == *"/life/%41%73%53e%54%73/%2e%2e/capture" ]]; then
    status=404
    body="reserved namespace traversal rejected"
    content_type="text/plain; charset=utf-8"
  elif [[ "$url" == *"/assets//%2e%2e/settings" ]]; then
    status=404
    body="reserved namespace traversal rejected"
    content_type="text/plain; charset=utf-8"
  elif [[ "$url" == *"/api/%2F%2e%2e%2Fsettings" || "$url" == *"/life/api//%2e%2e/capture" || "$url" == *"/life/assets/%2F%2E%2e%2fcapture" ]]; then
    status=404
    body="reserved namespace traversal rejected"
    content_type="text/plain; charset=utf-8"
  elif [[ "$url" == "http://127.0.0.1:8080/healthz" ]]; then
    body="$TAILSCALE_HEALTH_BODY"
    content_type="application/json"
    if [[ "$TAILSCALE_FAIL_HEALTH" == "true" ]]; then
      return 1
    fi
  elif [[ "$url" == */login || "$url" == */settings || "$url" == *"/settings?return=/%41pi/../x" ]]; then
    body='<!doctype html><script type="module" src="/assets/index-shell.js"></script>'
    content_type="text/html; charset=utf-8"
    if [[ "$TAILSCALE_RESPONSE_SCENARIO" == "swapped" ]]; then
      body='<!doctype html><script type="module" src="/life/assets/index-life.js"></script>'
    fi
  elif [[ "$url" == */life/capture ]]; then
    body='<!doctype html><script type="module" src="/life/assets/index-life.js"></script>'
    content_type="text/html; charset=utf-8"
    if [[ "$TAILSCALE_RESPONSE_SCENARIO" == "swapped" ]]; then
      body='<!doctype html><script type="module" src="/assets/index-shell.js"></script>'
    fi
  elif [[ "$url" == */assets/__ops_origin_missing__.js || "$url" == */life/assets/__ops_origin_missing__.js ]]; then
    status=404
    body="missing asset"
    content_type="text/plain"
  elif [[ "$url" == */api/__ops_origin_boundary__.js || "$url" == */api/brain/__ops_origin_boundary__.js || "$url" == */life/api/__ops_origin_boundary__.js ]]; then
    status=404
    body='{"detail":"not found"}'
    content_type="application/json; charset=utf-8"
  elif [[ "$url" == */api/%2e%2e%2Fsettings || "$url" == */assets/%2e%2e%2Fsettings || "$url" == */life/api/%2e%2e%2Fcapture || "$url" == */life/assets/%2e%2e%2Fcapture ]]; then
    status=404
    body="reserved namespace traversal rejected"
    content_type="text/plain; charset=utf-8"
  elif [[ "$url" == */api/healthz || "$url" == */api/brain/health || "$url" == */life/api/healthz ]]; then
    body='{"status":"ok"}'
    content_type="application/json; charset=utf-8"
    if [[ "$TAILSCALE_RESPONSE_SCENARIO" == "api-html" && "$url" == */api/healthz ]]; then
      body='<!doctype html><script type="module" src="/assets/index-shell.js"></script>'
      content_type="text/html; charset=utf-8"
    elif [[ "$TAILSCALE_RESPONSE_SCENARIO" == "api-mislabeled" && "$url" == */api/brain/health ]]; then
      content_type="text/plain"
    fi
  fi
  if [[ -n "$output_file" ]]; then
    printf '%s' "$body" > "$output_file"
  else
    printf '%s' "$body"
  fi
  if [[ "$write_out" == "true" ]]; then
    printf '%s\\n%s' "$status" "$content_type"
  fi
}
`,
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.PATH = process.env.PATH ?? process.env.Path ?? "/usr/bin:/bin";
  env.BASH_ENV = shellPath(bashEnv);
  env.TAILSCALE_SERVE_TEST_ROOT = "1";
  env.TAILSCALE_CURL_LOG = shellPath(curlLog);
  env.TAILSCALE_FAIL_AT = failAt;
  env.TAILSCALE_FAIL_HEALTH = failHealth ? "true" : "false";
  env.TAILSCALE_FAIL_ROUTE = failRoute;
  env.TAILSCALE_FINAL_STATUS = finalStatus;
  env.TAILSCALE_HEALTH_BODY = healthBody;
  env.TAILSCALE_HUMAN_STATUS = humanStatus;
  env.TAILSCALE_INITIAL_STATUS = initialStatus;
  env.TAILSCALE_RESPONSE_SCENARIO = responseScenario;
  env.TAILSCALE_STATUS_COUNT = shellPath(statusCount);
  env.TAILSCALE_TEST_LOG = shellPath(log);
  const result = spawn([mode], { env });
  let calls = [];
  let curlCalls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    // An expected preflight failure occurs before the first tailscale call.
  }
  try {
    curlCalls = readFileSync(curlLog, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    // A command preflight can fail before curl is reached.
  }
  return { calls, curlCalls, result };
}

function classifyFixture(options = {}) {
  return applyFixture({ ...options, mode: "--classify-status" });
}

function statusWith(mutator) {
  const state = structuredClone(desiredState);
  mutator(state);
  return JSON.stringify(state);
}

test("dry run installs the root first and removes only the four known legacy mounts", () => {
  assert.deepEqual(run("--dry-run").split("\n"), [
    `sudo tailscale ${rootCommand}`,
    ...removalCommands.map((command) => `sudo tailscale ${command}`),
  ]);
});

test("migration never uses destructive reset or unsupported Services-config rollback", () => {
  const source = readFileSync(script, "utf8");
  assert.doesNotMatch(source, /tailscale serve reset/);
  assert.doesNotMatch(source, /tailscale serve (?:get-config|set-config)/);
});

test("dry run is the default and deterministic", () => {
  assert.equal(run(), run("--dry-run"));
  assert.equal(run(), run());
});

test("unknown and conflicting options fail closed", () => {
  for (const args of [["--unknown"], ["--apply", "--dry-run"]]) {
    const result = spawn(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/);
  }
});

for (const [label, initialStatus] of [
  ["null state", "null"],
  ["empty state", JSON.stringify({ TCP: {}, Web: {} })],
  ["full legacy state", legacyStatus],
  ["partial migration state", JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: {
      [serveHost]: {
        Handlers: {
          "/": { Proxy: rootProxy },
          "/life/api/": { Proxy: "http://127.0.0.1:8000" },
        },
      },
    },
  })],
]) {
  test(`status classifier reports ${label} as legacy without Serve writes`, () => {
    const { calls, curlCalls, result } = classifyFixture({ initialStatus });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "legacy\n");
    assert.equal(result.stderr, "");
    assert.deepEqual(calls, ["serve status --json"]);
    assert.deepEqual(curlCalls, []);
  });
}

test("status classifier reports the exact one-root state as gateway without Serve writes", () => {
  const { calls, curlCalls, result } = classifyFixture({ initialStatus: desiredStatus });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "gateway\n");
  assert.equal(result.stderr, "");
  assert.deepEqual(calls, ["serve status --json"]);
  assert.deepEqual(curlCalls, []);
});

for (const [label, options, diagnostic] of [
  ["unknown state", { initialStatus: JSON.stringify({ Unexpected: {} }) }, /supported migration state/],
  ["malformed JSON", { initialStatus: "{not-json" }, /invalid initial Serve JSON/],
  ["status failure", { failAt: "initial-status" }, /Serve status check failed/],
]) {
  test(`status classifier rejects ${label} without Serve writes`, () => {
    const { calls, curlCalls, result } = classifyFixture(options);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, diagnostic);
    assert.deepEqual(calls, ["serve status --json"]);
    assert.deepEqual(curlCalls, []);
  });
}

test("an unhealthy nginx origin prevents every Serve mutation", () => {
  const { calls, result } = applyFixture({ failHealth: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private nginx origin health check failed/);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(result.stdout, /^\+ /m);
});

test("a different service returning 2xx on port 8080 prevents every Serve mutation", () => {
  const { calls, result } = applyFixture({ healthBody: "not-nginx" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected private nginx origin health response/);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(result.stdout, /^\+ /m);
});

test("a representative private route failure prevents every Serve mutation", () => {
  const failedRoute = "http://127.0.0.1:8080/life/capture";
  const { calls, curlCalls, result } = applyFixture({ failRoute: failedRoute });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LifeOS capture could not be fetched/);
  assert.deepEqual(calls, []);
  assert.ok(curlCalls.includes(failedRoute));
});

for (const [scenario, failure] of [
  ["swapped", /Shell bundle/],
  ["api-html", /application\/json/],
  ["api-mislabeled", /application\/json/],
]) {
  test(`a ${scenario} loopback response prevents every Serve mutation`, () => {
    const { calls, result } = applyFixture({ responseScenario: scenario });
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls, []);
    assert.match(result.stderr, failure);
    assert.doesNotMatch(result.stdout, /^\+ /m);
  });
}

test("malformed initial JSON prevents every Serve mutation", () => {
  const { calls, result } = applyFixture({ initialStatus: "{not-json" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, ["serve status --json"]);
  assert.match(result.stderr, /invalid initial Serve JSON/);
  assert.doesNotMatch(calls.join("\n"), new RegExp(rootCommand));
});

test("initial verification rejects a numeric HTTPS listener flag before every Serve write", () => {
  const state = structuredClone(desiredState);
  state.TCP[443].HTTPS = 1;
  const { calls, result } = applyFixture({
    initialStatus: JSON.stringify(state),
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, ["serve status --json"]);
  assert.match(
    result.stderr,
    /initial Serve state is not a supported migration state/,
  );
  assert.doesNotMatch(result.stdout, /^\+ /m);
});

test("a null initial Serve config converges from no handlers to the exact root", () => {
  const { calls, result } = applyFixture({ initialStatus: "null" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, ["serve status --json", rootCommand, "serve status --json"]);
  assert.equal((result.stderr.match(/already absent/g) ?? []).length, 4);
  assert.match(result.stdout, /Serve status JSON before convergence:\nnull/);
});

test("empty initial schema siblings are a valid first-apply state", () => {
  const initialStatus = JSON.stringify({
    TCP: {},
    Web: {},
    Services: {},
    AllowFunnel: {},
    Foreground: {},
  });
  const { calls, result } = applyFixture({ initialStatus });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, ["serve status --json", rootCommand, "serve status --json"]);
});

const rejectedInitialStates = [
  ["a Funnel grant", {
    TCP: { 443: { HTTPS: true } },
    Web: { [serveHost]: { Handlers: { "/": { Proxy: rootProxy } } } },
    AllowFunnel: { [serveHost]: true },
  }],
  ["a Services configuration", {
    TCP: { 443: { HTTPS: true } },
    Web: { [serveHost]: { Handlers: { "/": { Proxy: rootProxy } } } },
    Services: { "svc:test": { TCP: 8000 } },
  }],
  ["a Foreground configuration", {
    TCP: { 443: { HTTPS: true } },
    Web: { [serveHost]: { Handlers: { "/": { Proxy: rootProxy } } } },
    Foreground: { [serveHost]: { SessionID: "unexpected" } },
  }],
  ["an unknown top-level field", {
    TCP: { 443: { HTTPS: true } },
    Web: { [serveHost]: { Handlers: { "/": { Proxy: rootProxy } } } },
    Unexpected: true,
  }],
  ["an extra TCP listener", {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
    Web: { [serveHost]: { Handlers: { "/": { Proxy: rootProxy } } } },
  }],
  ["an extra TCP handler field", {
    TCP: { 443: { HTTPS: true, TCPForward: "127.0.0.1:9000" } },
    Web: { [serveHost]: { Handlers: { "/": { Proxy: rootProxy } } } },
  }],
  ["an extra Web host", {
    TCP: { 443: { HTTPS: true } },
    Web: {
      [serveHost]: { Handlers: { "/": { Proxy: rootProxy } } },
      "other.example.ts.net:443": { Handlers: {} },
    },
  }],
  ["a Web host on the wrong listener", {
    TCP: { 443: { HTTPS: true } },
    Web: { "node.example.ts.net:8443": { Handlers: { "/": { Proxy: rootProxy } } } },
  }],
  ["an extra Web-host field", {
    TCP: { 443: { HTTPS: true } },
    Web: { [serveHost]: { Handlers: { "/": { Proxy: rootProxy } }, Unexpected: true } },
  }],
  ["an unknown handler", {
    TCP: { 443: { HTTPS: true } },
    Web: {
      [serveHost]: {
        Handlers: {
          "/": { Proxy: rootProxy },
          "/other/": { Proxy: "http://127.0.0.1:9000" },
        },
      },
    },
  }],
  ["an unexpected known-mount target", {
    TCP: { 443: { HTTPS: true } },
    Web: {
      [serveHost]: {
        Handlers: {
          "/": { Proxy: rootProxy },
          "/life/api/": { Proxy: "http://127.0.0.1:9999" },
        },
      },
    },
  }],
  ["an extra field on an otherwise known handler", {
    TCP: { 443: { HTTPS: true } },
    Web: {
      [serveHost]: {
        Handlers: {
          "/": { Proxy: rootProxy, Path: "" },
        },
      },
    },
  }],
];

for (const [label, state] of rejectedInitialStates) {
  test(`initial verification rejects ${label} before every Serve write`, () => {
    const { calls, result } = applyFixture({ initialStatus: JSON.stringify(state) });
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls, ["serve status --json"]);
    assert.match(result.stderr, /initial Serve state is not a supported migration state/);
    assert.doesNotMatch(result.stdout, /^\+ /m);
  });
}

const rejectedInitialSchemaTypes = [
  ["Services as an array", "Services", []],
  ["AllowFunnel as a boolean", "AllowFunnel", false],
  ["Foreground as a string", "Foreground", ""],
  ["TCP as an array", "TCP", []],
  ["Web as a boolean", "Web", false],
  ["an unknown empty top-level field", "Unexpected", {}],
];

for (const [label, field, value] of rejectedInitialSchemaTypes) {
  test(`initial verification rejects ${label} before every Serve write`, () => {
    const state = structuredClone(desiredState);
    state[field] = value;
    const { calls, result } = applyFixture({ initialStatus: JSON.stringify(state) });
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls, ["serve status --json"]);
    assert.match(result.stderr, /initial Serve state is not a supported migration state/);
    assert.doesNotMatch(result.stdout, /^\+ /m);
  });
}

test("a root installation failure leaves every legacy route untouched", () => {
  const { calls, result } = applyFixture({ failAt: "root" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, ["serve status --json", rootCommand]);
  assert.match(result.stderr, /legacy routes were not changed/);
});

test("a legacy removal failure occurs only after the root exists and never removes later routes", () => {
  const { calls, result } = applyFixture({ failAt: "remove:/life/api/" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, [
    "serve status --json",
    rootCommand,
    removalCommands[0],
    removalCommands[1],
    "serve status --json",
  ]);
  assert.match(result.stderr, /root proxy remains active/);
  assert.doesNotMatch(calls.join("\n"), /serve reset/);
});

test("steady-state reapply skips all four absent legacy mounts without parsing English errors", () => {
  const { calls, result } = applyFixture({ initialStatus: desiredStatus });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, ["serve status --json", rootCommand, "serve status --json"]);
  assert.equal((result.stderr.match(/already absent/g) ?? []).length, 4);
});

test("initial JSON selects only legacy mounts that actually exist", () => {
  const initialStatus = statusWith((state) => {
    state.Web[serveHost].Handlers["/life/api/"] = { Proxy: "http://127.0.0.1:8000" };
    state.Web[serveHost].Handlers["/api/brain/"] = { Proxy: "http://127.0.0.1:8100" };
  });
  const { calls, result } = applyFixture({ initialStatus });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    "serve status --json",
    rootCommand,
    removalCommands[1],
    removalCommands[3],
    "serve status --json",
  ]);
});

test("human status formatting cannot affect convergence", () => {
  const { calls, result } = applyFixture({
    humanStatus: "localization changed every word and delimiter |-- /api/",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.every((call) => call !== "serve status"));
  assert.equal(calls.filter((call) => call === "serve status --json").length, 2);
});

test("malformed final JSON is rejected after root-first convergence", () => {
  const { calls, result } = applyFixture({ finalStatus: "{" });
  assert.notEqual(result.status, 0);
  assert.equal(calls.at(-1), "serve status --json");
  assert.match(result.stderr, /invalid final Serve JSON/);
});

test("a null final config is never accepted as the one-root desired state", () => {
  const { calls, result } = applyFixture({ initialStatus: "null", finalStatus: "null" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, ["serve status --json", rootCommand, "serve status --json"]);
  assert.match(result.stderr, /final Serve state is not exactly one nginx root proxy/);
});

const rejectedFinalStates = [
  ["an unrelated Web handler", (state) => {
    state.Web[serveHost].Handlers["/other/"] = { Proxy: "http://127.0.0.1:9000" };
  }],
  ["the wrong root proxy", (state) => {
    state.Web[serveHost].Handlers["/"] = { Proxy: "http://127.0.0.1:9000" };
  }],
  ["a Web handler on the wrong listener", (state) => {
    state.Web["node.example.ts.net:8443"] = state.Web[serveHost];
    delete state.Web[serveHost];
  }],
  ["a Services configuration", (state) => {
    state.Services = { "svc:test": { TCP: 8000 } };
  }],
  ["an AllowFunnel configuration", (state) => {
    state.AllowFunnel = { [serveHost]: true };
  }],
  ["a Foreground configuration", (state) => {
    state.Foreground = { [serveHost]: { SessionID: "unexpected" } };
  }],
  ["a numeric HTTPS listener flag", (state) => {
    state.TCP[443].HTTPS = 1;
  }],
  ["an extra TCP listener", (state) => {
    state.TCP[8443] = { HTTPS: true };
  }],
  ["an unknown false TCP listener field", (state) => {
    state.TCP[443].Unexpected = false;
  }],
  ["an unknown empty Web-host field", (state) => {
    state.Web[serveHost].Unexpected = {};
  }],
  ["an unknown empty-string handler field", (state) => {
    state.Web[serveHost].Handlers["/"].Unexpected = "";
  }],
];

for (const [label, mutator] of rejectedFinalStates) {
  test(`final verification rejects ${label}`, () => {
    const { result } = applyFixture({ finalStatus: statusWith(mutator) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /final Serve state is not exactly one nginx root proxy/);
  });
}

const rejectedFinalSchemaTypes = [
  ["Services as an array", "Services", []],
  ["AllowFunnel as a boolean", "AllowFunnel", false],
  ["Foreground as a string", "Foreground", ""],
  ["TCP as an array", "TCP", []],
  ["Web as a boolean", "Web", false],
  ["an unknown empty top-level field", "Unexpected", {}],
];

for (const [label, field, value] of rejectedFinalSchemaTypes) {
  test(`final verification rejects ${label}`, () => {
    const state = structuredClone(desiredState);
    state[field] = value;
    const { result } = applyFixture({ finalStatus: JSON.stringify(state) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /final Serve state is not exactly one nginx root proxy/);
  });
}

test("final verification accepts legitimately omitted or empty sibling fields", () => {
  const state = structuredClone(desiredState);
  state.Services = {};
  state.AllowFunnel = {};
  state.Foreground = {};
  const { result } = applyFixture({ finalStatus: JSON.stringify(state) });
  assert.equal(result.status, 0, result.stderr);
});

test("a final status command failure is visible after the root was established", () => {
  const { calls, result } = applyFixture({ failAt: "final-status" });
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, [
    "serve status --json",
    rootCommand,
    ...removalCommands,
    "serve status --json",
  ]);
  assert.match(result.stderr, /final Serve status check failed/);
});

test("apply preflights, installs one root, removes legacy mounts, and prints JSON evidence", () => {
  const { calls, curlCalls, result } = applyFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    "serve status --json",
    rootCommand,
    ...removalCommands,
    "serve status --json",
  ]);
  assert.deepEqual(curlCalls, [
    "http://127.0.0.1:8080/healthz",
    "http://127.0.0.1:8080/login",
    "http://127.0.0.1:8080/settings",
    "http://127.0.0.1:8080/settings?return=/%41pi/../x",
    "http://127.0.0.1:8080/life/capture",
    "http://127.0.0.1:8080/assets/__ops_origin_missing__.js",
    "http://127.0.0.1:8080/life/assets/__ops_origin_missing__.js",
    "http://127.0.0.1:8080/api/__ops_origin_boundary__.js",
    "http://127.0.0.1:8080/api/brain/__ops_origin_boundary__.js",
    "http://127.0.0.1:8080/life/api/__ops_origin_boundary__.js",
    "http://127.0.0.1:8080/%2Fapi/%2e%2e/settings",
    "http://127.0.0.1:8080//api/../settings",
    "http://127.0.0.1:8080/./assets/../settings",
    "http://127.0.0.1:8080/%2Flife/api/%2e%2e/capture",
    "http://127.0.0.1:8080//life/api/../capture",
    "http://127.0.0.1:8080/./life/assets/../capture",
    "http://127.0.0.1:8080/%2F%61pi/%2e%2e/settings",
    "http://127.0.0.1:8080//assets/../settings",
    "http://127.0.0.1:8080/./%2E/%61ssets/%2e%2E/settings",
    "http://127.0.0.1:8080/%2Flife/%61pi/%2e%2e/capture",
    "http://127.0.0.1:8080//%6Cife/assets/../capture",
    "http://127.0.0.1:8080/./life/%2E/%61pi/%2e%2e/capture",
    "http://127.0.0.1:8080/%2E/%6cife/%2F%61ssets/%2e%2E/capture",
    "http://127.0.0.1:8080/foo/../api/../settings",
    "http://127.0.0.1:8080/%66oo/%2e%2e/%61pi/%2e%2e/settings",
    "http://127.0.0.1:8080//foo/../api/../settings",
    "http://127.0.0.1:8080/%2Ffoo/%2e%2e/api/%2e%2e/settings",
    "http://127.0.0.1:8080/life/foo/../assets/../capture",
    "http://127.0.0.1:8080/life/%66oo/%2e%2e/%61ssets/%2e%2e/capture",
    "http://127.0.0.1:8080/alpha/beta/../../api/v1/../../settings",
    "http://127.0.0.1:8080/life/one/two/../../assets/v1/../../capture",
    "http://127.0.0.1:8080/api/%2e%2e%2Fsettings",
    "http://127.0.0.1:8080/api/%2F%2e%2e%2Fsettings",
    "http://127.0.0.1:8080/assets/%2e%2e%2Fsettings",
    "http://127.0.0.1:8080/assets//%2e%2e/settings",
    "http://127.0.0.1:8080/life/api/%2e%2e%2Fcapture",
    "http://127.0.0.1:8080/life/api//%2e%2e/capture",
    "http://127.0.0.1:8080/life/assets/%2e%2e%2Fcapture",
    "http://127.0.0.1:8080/life/assets/%2F%2E%2e%2fcapture",
    "http://127.0.0.1:8080/%41pi/%2e%2e/settings",
    "http://127.0.0.1:8080/%41%50%49/%2e%2e/settings",
    "http://127.0.0.1:8080/%61%50i/%2e%2e/settings",
    "http://127.0.0.1:8080/%41ssets/../settings",
    "http://127.0.0.1:8080/%41%53%53%45%54%53/%2e%2e/settings",
    "http://127.0.0.1:8080/%61%53s%65%54%73/%2e%2e/settings",
    "http://127.0.0.1:8080/life/%41ssets/../capture",
    "http://127.0.0.1:8080/life/%41%73%53e%54%73/%2e%2e/capture",
    "http://127.0.0.1:8080/api/healthz",
    "http://127.0.0.1:8080/api/brain/health",
    "http://127.0.0.1:8080/life/api/healthz",
  ]);
  assert.match(result.stdout, /Serve status JSON before convergence/);
  assert.match(result.stdout, /Serve status JSON after convergence/);
  assert.match(result.stdout, /"Proxy": "http:\/\/127\.0\.0\.1:8080"/);
});
