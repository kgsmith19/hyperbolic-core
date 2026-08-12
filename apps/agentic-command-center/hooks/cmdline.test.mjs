// node --test hooks/cmdline.test.mjs  (run from C:\code\guards)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cmdQuote, spawnSpec, CmdQuoteError } from "./cmdline.mjs";

test("bare-safe args pass through untouched", () => {
  for (const a of ["-p", "--output-format", "stream-json", "C:\\tmp\\s.json", "a/b.mjs", "Read.Bash", "key=value", "@scope", "trailing\\"]) {
    assert.equal(cmdQuote(a), a);
  }
});

test("anything else is CRT-quoted; embedded quotes and backslash runs survive", () => {
  assert.equal(cmdQuote("two words"), '"two words"');
  assert.equal(cmdQuote(""), '""');
  assert.equal(cmdQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(cmdQuote("a b\\"), '"a b\\\\"');
  assert.equal(cmdQuote('back\\\\"slash'), '"back\\\\\\\\\\"slash"');
});

test("cmd metacharacters always end up inside quotes, never bare", () => {
  for (const a of ["a&b", "a|b", "a>b", "a<b", "a^b", "(a)", "a!b", "a;b", "a,b", "a b&c"]) {
    const q = cmdQuote(a);
    assert.ok(q.startsWith('"') && q.endsWith('"'), `${a} must be quoted, got ${q}`);
  }
});

test("what cannot be made safe throws, never mangles (fail closed)", () => {
  for (const a of ["line\nbreak", "cr\rhere", "%PATH%", "50%", "nul\0char"]) {
    assert.throws(() => cmdQuote(a), CmdQuoteError, a);
  }
});

test("spawnSpec invariant: shell:true never carries an args array (DEP0190 unrepresentable)", () => {
  const win = spawnSpec("claude", ["-p", "two words"], "win32");
  assert.equal(win.shell, true);
  assert.ok(!("args" in win), "shell spec must not carry args");
  assert.equal(win.file, 'claude -p "two words"');
  const posix = spawnSpec("claude", ["-p", "two words"], "linux");
  assert.deepEqual(posix, { file: "claude", args: ["-p", "two words"], shell: false });
});

test("real spawn round-trip: hostile argv arrives byte-identical on THIS platform", () => {
  const hostile = ["two words", 'say "hi"', "a&b|c>d<e", "(paren)!bang", "comma,semi;colon", "a b\\", ""];
  const probe = "console.log(JSON.stringify(process.argv.slice(1)))";
  const sp = spawnSpec(process.execPath, ["-e", probe, ...hostile]);
  const r = sp.args
    ? spawnSync(sp.file, sp.args, { encoding: "utf8" })
    : spawnSync(sp.file, { shell: true, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout);
  assert.deepEqual(seen.slice(-hostile.length), hostile);
});
