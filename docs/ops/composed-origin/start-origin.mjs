import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const edgeOrigin = path.join(repoRoot, "docs/ops/edge-origin");
const shellDist = path.join(repoRoot, "apps/shell/frontend/dist");
const lifeDist = path.join(repoRoot, "apps/lifeos/frontend/dist");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const buildEnvironment = {
  ...process.env,
  VITE_E2E_HOOKS: "1",
  VITE_SUPABASE_URL: "https://test.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "test-public-anon-key",
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: buildEnvironment,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
}

function buildBundles() {
  run(npm, ["run", "build", "--workspace=@hyperbolic/ui"]);
  run(npm, ["run", "build:app", "--workspace=apps/shell"]);
  run(npm, ["run", "build"], {
    cwd: path.join(repoRoot, "apps/lifeos/frontend"),
  });
}

function commandExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function normalized(value) {
  return value.replaceAll("\\", "/");
}

function prepareNativeConfig(nginxBinary) {
  const distributionRoot = path.dirname(nginxBinary);
  const packagedConf = path.join(distributionRoot, "conf");
  if (!existsSync(path.join(packagedConf, "mime.types"))) {
    throw new Error(
      `native nginx distribution is missing conf/mime.types beside ${nginxBinary}`,
    );
  }

  const runtime = mkdtempSync(
    path.join(os.tmpdir(), "hyperbolic-composed-nginx-"),
  );
  const runtimeConf = path.join(runtime, "conf");
  cpSync(packagedConf, runtimeConf, { recursive: true });
  mkdirSync(path.join(runtime, "logs"), { recursive: true });
  mkdirSync(path.join(runtime, "temp"), { recursive: true });

  const replacements = [
    ["/etc/nginx/", `${normalized(runtimeConf)}/`],
    ["/home/deploy/shell/current", normalized(shellDist)],
    ["/home/deploy/lifeos-ui/current", normalized(lifeDist)],
    ["127.0.0.1:8080", "127.0.0.1:18080"],
    ["127.0.0.1:8081", "127.0.0.1:18081"],
    [
      "/tmp/edge-origin-nginx.pid",
      `${normalized(path.join(runtime, "logs"))}/edge-origin-nginx.pid`,
    ],
  ];

  for (const entry of readdirSync(edgeOrigin, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".conf")) continue;
    let content = readFileSync(path.join(edgeOrigin, entry.name), "utf8");
    for (const [from, to] of replacements)
      content = content.replaceAll(from, to);
    writeFileSync(path.join(runtimeConf, entry.name), content);
  }
  return runtime;
}

function startNative(nginxBinary) {
  const runtime = prepareNativeConfig(nginxBinary);
  const child = spawn(
    nginxBinary,
    [
      "-p",
      `${runtime}${path.sep}`,
      "-c",
      path.join(runtime, "conf/nginx.conf"),
      "-g",
      "daemon off;",
    ],
    { cwd: runtime, stdio: "inherit" },
  );
  return {
    child,
    cleanup() {
      child.kill();
      rmSync(runtime, { recursive: true, force: true });
    },
  };
}

function startDocker() {
  const composeFile = path.join(here, "compose.yml");
  const project = `hyperbolic-composed-e2e-${process.pid}`;
  const args = ["compose", "--project-name", project, "--file", composeFile];
  const child = spawn(
    "docker",
    [...args, "up", "--force-recreate", "--abort-on-container-exit"],
    {
      cwd: here,
      stdio: "inherit",
    },
  );
  return {
    child,
    cleanup() {
      spawnSync("docker", [...args, "down", "--volumes", "--remove-orphans"], {
        cwd: here,
        stdio: "inherit",
      });
    },
  };
}

async function startApiStub(port) {
  const server = createServer((request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "composed-origin-api-stub",
        path: request.url,
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

const apiStubs = [];
try {
  for (const port of [8000, 8100, 8200]) {
    apiStubs.push(await startApiStub(port));
  }
} catch (error) {
  for (const server of apiStubs) server.close();
  throw error;
}

buildBundles();

let running;
const explicitNginx = process.env.COMPOSED_NGINX_BIN;
if (explicitNginx) {
  if (!existsSync(explicitNginx))
    throw new Error(`COMPOSED_NGINX_BIN does not exist: ${explicitNginx}`);
  running = startNative(path.resolve(explicitNginx));
} else if (commandExists("docker", ["version"])) {
  running = startDocker();
} else {
  throw new Error(
    "composed-origin e2e requires Docker or a native nginx binary supplied through COMPOSED_NGINX_BIN",
  );
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  running.cleanup();
  for (const server of apiStubs) server.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}

running.child.on("error", (error) => {
  cleanup();
  throw error;
});
running.child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 1);
});
