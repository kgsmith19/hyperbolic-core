// Structural and behavioral assertions over .github/workflows/ops-storagebox-authorize-key.yml
// (hyperbolic-core#469, AC2 and AC3). The workflow rotates the Storage Box password and
// installs the restic public key, so its safety is its SHAPE: dispatch-only, one job in the
// production environment, the same pins platform-backup.yml uses, secrets only through env:,
// the password masked before first use, and nothing but the fingerprint written to the summary.
// The behavioral half runs the real run: script with stub curl, ssh, sshpass, ssh-keygen and
// sleep on PATH. Nothing touches the network, Hetzner, or Infisical.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/ops-storagebox-authorize-key.yml");
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "";
const platformBackup = readFileSync(path.join(root, ".github/workflows/platform-backup.yml"), "utf8");

/** Non-comment lines only, so a comment that mentions a verb cannot trip a rule. */
const code = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

const API = "https://api.hetzner.com/v1";
const HOST = "u657401.your-storagebox.de";
const USER = "u657401";
const PUBLIC_LINE = "ssh-ed25519 AAAAC3FAKEPUBLIC storagebox-restic";
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEPRIVATEKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n";
const HETZNER_TOKEN = "hetzner-token-FAKE-0123";

/** The top-level `on:` block's own keys, read from the first line under `on:`. */
function triggerKeys() {
  const start = workflow.indexOf("\non:\n");
  assert.ok(start > -1, "no top-level on: block");
  const rest = workflow.slice(start + "\non:\n".length);
  const end = rest.search(/\n(?=[A-Za-z_-]+:)/);
  const block = end > -1 ? rest.slice(0, end) : rest;
  return [...block.matchAll(/^ {2}([A-Za-z_]+):/gm)].map((m) => m[1]);
}

/** The `run:` script of one named step, dedented to column zero. */
function stepRun(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start > -1, `step "${name}" not found`);
  const runAt = workflow.indexOf("        run: |\n", start);
  assert.ok(runAt > -1, `step "${name}" has no run: script`);
  const bodyStart = runAt + "        run: |\n".length;
  const next = workflow.indexOf("\n      - ", bodyStart);
  const body = workflow.slice(bodyStart, next > -1 ? next : undefined);
  return body
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

const MAIN_STEP = "Authorize the restic key on the Storage Box";
const CLEANUP_STEP = "Shred the temporary key files";

// --- trigger, identity, and environment ---

test("the workflow file exists", () => {
  assert.ok(workflow !== "", `${path.relative(root, workflowPath)} is missing`);
});

test("dispatch-only: the sole trigger is workflow_dispatch, with no inputs and no schedule or push", () => {
  // A person decides when a box's password is rotated; no event may do it for them.
  assert.deepEqual(triggerKeys(), ["workflow_dispatch"]);
  assert.doesNotMatch(workflow, /\n {2}workflow_dispatch:\n {4}inputs:/);
});

test("exactly one job, in the platform-backup-production environment that the restic backup already uses", () => {
  const jobIds = [...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(jobIds, ["authorize-key"]);
  const environments = workflow.match(/^\s*environment:.*$/gm) ?? [];
  assert.deepEqual(environments.map((line) => line.trim()), ["environment: platform-backup-production"]);
});

test("permissions are exactly contents read at the top level, and contents read plus id-token write on the job", () => {
  const blocks = [...workflow.matchAll(/^( *)permissions:\n((?:\1 {2}[a-z-]+: [a-z]+\n)+)/gm)].map(
    ([, indent, body]) => ({ indent, pairs: [...body.matchAll(/([a-z-]+): ([a-z]+)/g)].map((m) => `${m[1]}:${m[2]}`) }),
  );
  assert.equal(blocks.length, 2, "expected exactly a top-level and a job-level permissions block");
  const [topLevel, job] = blocks;
  assert.equal(topLevel.indent, "", "first permissions block must be top level");
  assert.deepEqual(topLevel.pairs, ["contents:read"]);
  assert.equal(job.indent, "    ", "second permissions block must be job level");
  assert.deepEqual(job.pairs, ["contents:read", "id-token:write"]);
  assert.doesNotMatch(code, /\b(packages|pull-requests|issues|actions|checks|statuses|deployments|contents): write\b/);
});

test("concurrency: one run at a time under a single group, and a running authorization is never cancelled", () => {
  assert.match(workflow, /\nconcurrency:\n {2}group: ops-storagebox-authorize-key\n {2}cancel-in-progress: false\n/);
});

test("the only repository variables consumed are the Storage Box host and user and the restic identity and project", () => {
  const vars = new Set([...code.matchAll(/vars\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...vars].sort(), ["INFISICAL_PLATFORM_RESTIC_IDENTITY_ID", "INFISICAL_PROJECT_SLUG", "STORAGEBOX_HOST", "STORAGEBOX_USER"]);
});

// --- pinned actions and the Infisical read ---

test("every uses: is a full 40-hex SHA, and each is the same pin platform-backup.yml already uses", () => {
  const refs = [...workflow.matchAll(/uses: ([^\s#]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(refs.map((ref) => ref.split("@")[0]))].sort(),
    ["Infisical/secrets-action", "actions/checkout"],
  );
  for (const ref of refs) {
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is not pinned to a full SHA`);
    assert.ok(platformBackup.includes(`uses: ${ref}`), `${ref} is not the pin platform-backup.yml uses`);
  }
});

test("the Infisical step reads /platform/backup/ through the restic identity, exactly as platform-backup.yml's restic step does", () => {
  assert.match(workflow, /method: oidc/);
  assert.match(workflow, /identity-id: \$\{\{ vars\.INFISICAL_PLATFORM_RESTIC_IDENTITY_ID \}\}/);
  assert.match(workflow, /project-slug: \$\{\{ vars\.INFISICAL_PROJECT_SLUG \}\}/);
  assert.match(workflow, /env-slug: prod/);
  assert.match(workflow, /secret-path: "\/platform\/backup\/"/);
  assert.match(workflow, /domain: https:\/\/app\.infisical\.com/);
});

test("secrets reach run: scripts only through env:, never inline as ${{ secrets }} or ${{ env }} inside a script", () => {
  assert.ok(workflow !== "", "workflow missing: a negative pin over an empty file proves nothing");
  assert.doesNotMatch(code, /\$\{\{\s*secrets\./);
  const inlineExpressions = code
    .split("\n")
    .filter((line) => line.includes("${{"))
    .filter((line) => !/^\s*[A-Za-z_-]+: \$\{\{ (vars|env)\.[A-Za-z_]+ \}\}\s*$/.test(line));
  assert.deepEqual(inlineExpressions, [], "an expression outside a plain env:/with: mapping");
});

test("sshpass is installed with sudo apt-get install -y sshpass, after an apt-get update so a stale index cannot fail the run", () => {
  assert.match(code, /sudo apt-get install -y sshpass/);
  const update = code.indexOf("sudo apt-get update");
  assert.ok(update >= 0, "apt-get update must run before installing sshpass");
  assert.ok(update < code.indexOf("sudo apt-get install -y sshpass"), "apt-get update must precede the install");
});

// --- ordering: the steps run in the order AC2 lists ---

test("the steps run in the order AC2 lists: key file, public key, find box, enable SSH, password, install, prove, summary", () => {
  const script = stepRun(MAIN_STEP);
  const markers = [
    "> \"$key_file\"", // 1-2: private key written to the 0600 file
    "ssh-keygen -y -f", // 3: public key derived
    "/storage_boxes?page=", // 4: box found
    "update_access_settings", // 5: SSH enabled
    "openssl rand", // 6: password generated
    "reset_password", // 6: password reset
    "install-ssh-key", // 7: key installed
    "BatchMode=yes", // 8: key-only login proven
    "GITHUB_STEP_SUMMARY", // 9: summary written
  ];
  const positions = markers.map((marker) => {
    const at = script.indexOf(marker);
    assert.ok(at > -1, `marker not found in the main step: ${marker}`);
    return at;
  });
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "steps are out of order");
});

// --- password masking and secret echoes ---

test("the password is masked with add-mask before its first use, and before the reset_password call", () => {
  const script = stepRun(MAIN_STEP);
  const generated = script.indexOf("openssl rand");
  const mask = script.indexOf("echo \"::add-mask::$pw\"");
  const reset = script.indexOf("reset_password");
  assert.ok(generated > -1 && mask > generated, "add-mask must follow generation");
  assert.ok(reset > mask, "add-mask must precede the reset_password call");
  assert.doesNotMatch(script.slice(generated, mask), /\$\{?pw\b/, "the password is used before it is masked");
});

test("no set -x, xtrace, or bash -x anywhere: a trace would print the token and the password", () => {
  assert.ok(workflow !== "", "workflow missing: a negative pin over an empty file proves nothing");
  assert.doesNotMatch(code, /\bset\s+-[a-zA-Z]*x\b|xtrace|\bbash\s+-x\b/);
});

test("no echo or printf of a secret variable, except the add-mask line and a pipe into sshpass's ssh stdin", () => {
  const secret = /\$\{?(pw|SSHPASS|STORAGEBOX_SSH_KEY|HETZNER_API_TOKEN)\b/;
  for (const script of [stepRun(MAIN_STEP), stepRun(CLEANUP_STEP)]) {
    for (const line of script.split("\n")) {
      if (!/\b(echo|printf)\b/.test(line) || !secret.test(line)) continue;
      const allowed = /::add-mask::/.test(line) || /\|\s*sshpass\b/.test(line);
      assert.ok(allowed, `secret echoed or printed: ${line.trim()}`);
    }
  }
});

test("the private key is written to a file by a here-string, never by printf or echo", () => {
  const script = stepRun(MAIN_STEP);
  assert.match(script, /umask 077/);
  assert.match(script, /cat > "\$key_file" <<<"\$STORAGEBOX_SSH_KEY"/);
  assert.match(script, /chmod 0600 "\$key_file"/);
});

// --- the summary and cleanup ---

test("the step summary is written exactly once, and only the key fingerprint and the box id go into it", () => {
  assert.equal((code.match(/GITHUB_STEP_SUMMARY/g) ?? []).length, 1, "GITHUB_STEP_SUMMARY must be written exactly once");
  assert.match(stepRun(MAIN_STEP), /printf 'Storage Box id %s: key fingerprint %s[^']*'\s*\\\n\s*"\$box_id" "\$fingerprint" >> "\$GITHUB_STEP_SUMMARY"/);
  assert.match(stepRun(MAIN_STEP), /fingerprint="\$\(ssh-keygen -lf "\$pub_file" \| awk '\{print \$2\}'\)"/);
});

test("the cleanup step is last, runs always, and shreds both temporary files under RUNNER_TEMP", () => {
  const steps = workflow.split(/\n {6}- /).slice(1);
  const cleanup = steps.find((step) => step.includes(`name: ${CLEANUP_STEP}`));
  assert.ok(cleanup, "cleanup step not found");
  assert.equal(steps.at(-1), cleanup, "the cleanup step must be the last step");
  assert.match(cleanup, /\n {8}if: always\(\)\n/);
  assert.match(stepRun(CLEANUP_STEP), /shred -u "\$f"/);
  assert.match(stepRun(CLEANUP_STEP), /"\$RUNNER_TEMP\/storagebox-authorize\.key"/);
  assert.match(stepRun(CLEANUP_STEP), /"\$RUNNER_TEMP\/storagebox-authorize\.pub"/);
});

// --- behavioral: run the real script under stubs, record what it sends ---

/** Node stub shared by every fake binary. It records argv, stdin and a few facts per call. */
const STUB_JS = `
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
const [name, ...args] = process.argv.slice(2);
const log = process.env.STUB_LOG;
const before = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const stdin = readFileSync(0, "utf8");
const record = { name, args, stdin };
if (name === "sshpass") record.sshpass = process.env.SSHPASS ?? null;
if (name === "ssh-keygen" && args.includes("-y")) record.mode = (statSync(args[args.indexOf("-f") + 1]).mode & 0o777).toString(8);
appendFileSync(log, JSON.stringify(record) + "\\n");
const out = (text) => process.stdout.write(text);
if (name === "curl") {
  const url = args.find((a) => a.startsWith("https://")) ?? "";
  if (url.includes("/storage_boxes/actions/")) {
    const polls = before.filter((c) => c.name === "curl" && c.args.some((a) => a.includes("/storage_boxes/actions/"))).length;
    const seq = process.env.STUB_ACTION_SEQ.split(",");
    out(JSON.stringify({ action: { id: 77, status: seq[Math.min(polls, seq.length - 1)] } }) + "\\n");
  } else if (url.includes("/storage_boxes?")) {
    const page = new URL(url).searchParams.get("page");
    out(process.env["STUB_PAGE" + page] ?? JSON.stringify({ storage_boxes: [], meta: { pagination: { next_page: null } } }));
  } else {
    out(JSON.stringify({ action: { id: 77, status: "running" } }) + "\\n");
  }
}
if (name === "sshpass") {
  const tries = before.filter((c) => c.name === "sshpass").length;
  const seq = (process.env.STUB_SSHPASS_SEQ || "0").split(",");
  process.exit(Number(seq[Math.min(tries, seq.length - 1)]));
}
if (name === "ssh") process.exit(args.includes("BatchMode=yes") && process.env.STUB_LOGIN_FAIL === "1" ? 255 : 0);
if (name === "ssh-keygen") out(args.includes("-y") ? PUBLIC_LINE + "\\n" : "256 SHA256:FAKEFINGERPRINT storagebox-restic (ED25519)\\n");
`;

function stubScript(jsPath, name) {
  return `#!/bin/sh\nexec '${process.execPath}' '${jsPath}' ${name} "$@"\n`;
}

/** Storage Box list pages. Page 1 holds `other` boxes; page 2 holds the given matches. */
function pages(page2Matches, page1 = [{ id: 900, username: "someone-else" }], access = { reachable_externally: true, ssh_enabled: false }) {
  return {
    STUB_PAGE1: JSON.stringify({ storage_boxes: page1, meta: { pagination: { next_page: 2 } } }),
    STUB_PAGE2: JSON.stringify({
      storage_boxes: page2Matches.map((id) => ({ id, username: USER, access_settings: access })),
      meta: { pagination: { next_page: null } },
    }),
  };
}

/** Runs the real main-step script under stubs; returns what each stub was asked to do. */
function runAuthorize({ page, actionSeq = "running,success,running,success", loginFail = false, token = HETZNER_TOKEN, sshpassSeq = "0" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "storagebox-authorize-"));
  try {
    const stubDir = path.join(dir, "bin");
    const runnerTemp = path.join(dir, "runner");
    mkdirSync(stubDir);
    mkdirSync(runnerTemp);
    const stubJs = path.join(dir, "stub.mjs");
    writeFileSync(stubJs, STUB_JS.replace("PUBLIC_LINE", JSON.stringify(PUBLIC_LINE)));
    for (const name of ["curl", "ssh", "sshpass", "ssh-keygen"]) {
      writeFileSync(path.join(stubDir, name), stubScript(stubJs, name), { mode: 0o755 });
    }
    const sleepLog = path.join(dir, "sleep.log");
    writeFileSync(path.join(stubDir, "sleep"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sleepLog}'\nexit 0\n`, { mode: 0o755 });
    // jq is real; this pass-through wrapper only records its argv, so a test can
    // prove no secret ever rides on a command line (visible in /proc to the runner).
    const realJq = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
    const jqArgvLog = path.join(dir, "jq-argv.log");
    writeFileSync(path.join(stubDir, "jq"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${jqArgvLog}'\nexec '${realJq}' "$@"\n`, { mode: 0o755 });

    const callLog = path.join(dir, "calls.jsonl");
    const summary = path.join(dir, "summary.md");
    writeFileSync(summary, "");
    const scriptPath = path.join(dir, "authorize-step.sh");
    writeFileSync(scriptPath, stepRun(MAIN_STEP));

    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      input: "",
      env: {
        PATH: `${stubDir}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        GITHUB_STEP_SUMMARY: summary,
        STORAGEBOX_HOST: HOST,
        STORAGEBOX_USER: USER,
        STORAGEBOX_SSH_KEY: PRIVATE_KEY,
        HETZNER_API_TOKEN: token,
        STUB_LOG: callLog,
        STUB_ACTION_SEQ: actionSeq,
        STUB_LOGIN_FAIL: loginFail ? "1" : "0",
        STUB_SSHPASS_SEQ: sshpassSeq,
        ...page,
      },
    });
    const raw = existsSync(callLog) ? readFileSync(callLog, "utf8") : "";
    const calls = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return {
      sleeps: existsSync(sleepLog) ? readFileSync(sleepLog, "utf8").split("\n").filter(Boolean) : [],
      jqArgv: existsSync(jqArgvLog) ? readFileSync(jqArgvLog, "utf8") : "",
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      summaryText: readFileSync(summary, "utf8"),
      raw,
      calls,
      curl: calls.filter((c) => c.name === "curl").map((c) => ({
        method: c.args.includes("-X") ? "POST" : "GET",
        path: c.args.find((a) => a.startsWith("https://")).slice(API.length),
        body: c.stdin,
      })),
      sshCalls: calls.filter((c) => c.name === "ssh"),
      sshpassCalls: calls.filter((c) => c.name === "sshpass"),
      keygenCalls: calls.filter((c) => c.name === "ssh-keygen"),
      runnerTemp,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("behavior: a single match on page 2 drives the exact Hetzner calls, in order, with the right bodies", () => {
  const run = runAuthorize({ page: pages([111]) });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    run.curl.map(({ method, path: p }) => `${method} ${p}`),
    [
      "GET /storage_boxes?page=1&per_page=50",
      "GET /storage_boxes?page=2&per_page=50",
      "POST /storage_boxes/111/actions/update_access_settings",
      "GET /storage_boxes/actions/77",
      "GET /storage_boxes/actions/77",
      "POST /storage_boxes/111/actions/reset_password",
      "GET /storage_boxes/actions/77",
      "GET /storage_boxes/actions/77",
    ],
  );
  assert.deepEqual(JSON.parse(run.curl[2].body), { ssh_enabled: true });
  assert.deepEqual(Object.keys(JSON.parse(run.curl[5].body)), ["password"]);
});

test("behavior: install-ssh-key receives the PUBLIC key on stdin, and the private key appears in no call at all", () => {
  const run = runAuthorize({ page: pages([111]) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.sshpassCalls.length, 1);
  const install = run.sshpassCalls[0];
  assert.equal(install.args[0], "-e");
  assert.ok(install.args.includes("install-ssh-key"));
  assert.equal(install.stdin, `${PUBLIC_LINE}\n`);
  assert.doesNotMatch(run.raw, /FAKEPRIVATEKEYMATERIAL/, "the private key reached a command or its stdin");
});

test("behavior: the private key file is 0600 when ssh-keygen derives the public key from it", () => {
  const run = runAuthorize({ page: pages([111]) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.keygenCalls.length, 2);
  const derive = run.keygenCalls.find((c) => c.args.includes("-y"));
  assert.equal(derive.args[derive.args.indexOf("-f") + 1], path.join(run.runnerTemp, "storagebox-authorize.key"));
  assert.equal(derive.mode, "600");
});

test("behavior: the BatchMode proof logs in with the key only, and never by password", () => {
  const run = runAuthorize({ page: pages([111]) });
  assert.equal(run.status, 0, run.stderr);
  const proof = run.sshCalls.find((c) => c.args.includes("BatchMode=yes"));
  assert.ok(proof, "no BatchMode login was attempted");
  assert.deepEqual(
    proof.args.map((a) => (a.startsWith(run.runnerTemp) ? "<key>" : a)),
    ["-p23", "-i", "<key>", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "-o", "IdentitiesOnly=yes", `${USER}@${HOST}`, "ls"],
  );
  assert.equal(run.sshpassCalls.length, 1, "only the install step may use a password");
});

test("behavior: the generated password is 32 characters with all four classes, and sshpass installs with that same password", () => {
  const run = runAuthorize({ page: pages([111]) });
  assert.equal(run.status, 0, run.stderr);
  const reset = JSON.parse(run.curl[5].body).password;
  assert.equal(reset.length, 32);
  assert.match(reset, /[A-Z]/);
  assert.match(reset, /[a-z]/);
  assert.match(reset, /[0-9]/);
  assert.match(reset, /[^A-Za-z0-9]/);
  assert.equal(run.sshpassCalls[0].sshpass, reset);
});

test("behavior: the generated password never appears on stdout or in the summary (the add-mask line is the runner's, not a log line)", () => {
  const run = runAuthorize({ page: pages([111]) });
  assert.equal(run.status, 0, run.stderr);
  const pw = JSON.parse(run.curl[5].body).password;
  const maskLines = run.stdout.split("\n").filter((l) => l.startsWith("::add-mask::"));
  assert.deepEqual(maskLines, [`::add-mask::${pw}`]);
  const visibleStdout = run.stdout.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n");
  assert.ok(!visibleStdout.includes(pw), "password on stdout");
  assert.ok(!run.summaryText.includes(pw), "password in the summary");
  assert.ok(!run.stderr.includes(pw), "password on stderr");
  assert.ok(!run.summaryText.includes(HETZNER_TOKEN) && !visibleStdout.includes(HETZNER_TOKEN), "token printed");
});

test("behavior: the summary holds exactly one line, with the box id and the key fingerprint and nothing else", () => {
  const run = runAuthorize({ page: pages([111]) });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.summaryText.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\b111\b/);
  assert.match(lines[0], /SHA256:FAKEFINGERPRINT/);
  assert.doesNotMatch(lines[0], /storagebox-restic|ED25519/, "the fingerprint line's comment must not be copied");
});

test("behavior: zero matching boxes fails closed before anything is changed", () => {
  const run = runAuthorize({ page: pages([]) });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.curl.filter((c) => c.method === "POST"), []);
  assert.equal(run.summaryText, "");
});

test("behavior: two matching boxes fails closed before anything is changed", () => {
  const run = runAuthorize({ page: pages([111, 222]) });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.curl.filter((c) => c.method === "POST"), []);
  assert.equal(run.summaryText, "");
});

test("behavior: an action that ends in error fails the run, and the password is never reset", () => {
  const run = runAuthorize({ page: pages([111]), actionSeq: "running,error" });
  assert.notEqual(run.status, 0);
  assert.deepEqual(
    run.curl.filter((c) => c.method === "POST").map((c) => c.path),
    ["/storage_boxes/111/actions/update_access_settings"],
  );
  assert.equal(run.sshpassCalls.length, 0);
});

test("behavior: a failed key-only login proof fails the run, and the summary is not written", () => {
  const run = runAuthorize({ page: pages([111]), loginFail: true });
  assert.notEqual(run.status, 0);
  assert.ok(run.sshCalls.some((c) => c.args.includes("BatchMode=yes")), "the proof was attempted");
  assert.equal(run.summaryText, "");
});

test("behavior: the generated password never appears on any command line (jq reads it from the environment)", () => {
  const run = runAuthorize({ page: pages([111]) });
  assert.equal(run.status, 0, run.stderr);
  const pw = run.sshpassCalls[0].sshpass;
  assert.ok(pw && pw.length >= 12, "sshpass received the generated password");
  assert.ok(run.jqArgv.length > 0, "the jq wrapper recorded calls");
  assert.ok(!run.jqArgv.includes(pw), "the password must not be passed to jq as an argument");
  assert.ok(!run.raw.split("\n").some((l) => l && JSON.parse(l).args.join(" ").includes(pw)), "the password must not be in any stub's argv");
});

test("behavior: a missing HETZNER_API_TOKEN fails fast, before any API call, and names the runbook prerequisite", () => {
  const run = runAuthorize({ page: pages([111]), token: "" });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.curl, [], "no Hetzner call may be attempted without a token");
  assert.match(run.stderr, /HETZNER_API_TOKEN/);
  assert.match(run.stderr, /runbook/i);
  assert.equal(run.summaryText, "");
});

// --- the fresh password reaches the box's SSH frontend with a lag (CI run 40625385188) ---

/** sshpass exit 5: the box refused the password. Other codes are real failures. */
const REFUSED = 5;
const INSTALL_ATTEMPTS = 18;

test("behavior: a password the box still refuses (sshpass exit 5) is retried with a 20s wait, and the run then succeeds", () => {
  const run = runAuthorize({ page: pages([111]), sshpassSeq: `${REFUSED},${REFUSED},0` });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.sshpassCalls.length, 3);
  for (const call of run.sshpassCalls) assert.equal(call.stdin, `${PUBLIC_LINE}\n`, "each attempt sends the public key");
  const pw = JSON.parse(run.curl[5].body).password;
  assert.ok(run.sshpassCalls.every((c) => c.sshpass === pw), "every attempt uses the one reset password");
  assert.deepEqual(run.sleeps.filter((s) => s === "20"), ["20", "20"]);
  assert.match(run.summaryText, /key-only login verified/);
  assert.ok(!run.stderr.includes(pw), "password on stderr");
});

test("behavior: a refusal that never clears fails after a bounded number of attempts, and nothing is proven or summarized", () => {
  const run = runAuthorize({ page: pages([111]), sshpassSeq: String(REFUSED) });
  assert.notEqual(run.status, 0);
  assert.equal(run.sshpassCalls.length, INSTALL_ATTEMPTS);
  assert.ok(!run.sshCalls.some((c) => c.args.includes("BatchMode=yes")), "no proof after a failed install");
  assert.equal(run.summaryText, "");
  assert.match(run.stderr, /sshpass exit 5/);
});

test("behavior: any other install failure (not exit 5) fails at once, without a retry", () => {
  const run = runAuthorize({ page: pages([111]), sshpassSeq: "255,0" });
  assert.notEqual(run.status, 0);
  assert.equal(run.sshpassCalls.length, 1);
  assert.ok(!run.sleeps.includes("20"), "no retry wait for a non-refusal failure");
  assert.equal(run.summaryText, "");
});

// --- a box not reachable from outside Hetzner refuses every runner login (run 40626356955) ---

test("behavior: a box with reachable_externally false fails closed before any change, and says why", () => {
  const run = runAuthorize({ page: pages([111], undefined, { reachable_externally: false, ssh_enabled: true }) });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.curl.filter((c) => c.method === "POST"), [], "no setting or password may change");
  assert.equal(run.sshpassCalls.length, 0);
  assert.match(run.stderr, /reachable_externally=false/);
  assert.match(run.stderr, /External Reachability/);
  assert.equal(run.summaryText, "");
});

test("behavior: the box's access settings (booleans only) are logged before any change", () => {
  const run = runAuthorize({ page: pages([111]) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Storage Box 111 access settings: reachable_externally=true ssh_enabled=false/);
});
