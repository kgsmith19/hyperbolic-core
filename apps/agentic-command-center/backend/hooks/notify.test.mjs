// node --test hooks/notify.test.mjs  (run from C:\code\guards)
import { test } from "node:test";
import assert from "node:assert/strict";
import { notify, notifyArgs } from "./notify.mjs";

test("notifyArgs: title/body land in the ShowBalloonTip call, single quotes doubled for PowerShell safety", () => {
  const args = notifyArgs("ACC directive done", "Kyle's task: fix the thing");
  assert.equal(args[0], "-NoProfile");
  assert.equal(args[1], "-WindowStyle");
  assert.equal(args[2], "Hidden");
  const script = args[4];
  assert.match(script, /ShowBalloonTip\(5000, 'ACC directive done', 'Kyle''s task: fix the thing', 'Info'\)/);
  assert.match(script, /System\.Windows\.Forms\.NotifyIcon/);
});

test("notify: non-Windows platform never spawns", () => {
  let called = false;
  notify("t", "b", { platform: "linux", spawnFn: () => { called = true; return { unref() {} }; } });
  assert.equal(called, false);
});

test("notify: Windows platform spawns powershell with the built args and unrefs the child", () => {
  let seen = null;
  let unreffed = false;
  notify("t", "b", {
    platform: "win32",
    spawnFn: (bin, args) => {
      seen = { bin, args };
      return { unref: () => { unreffed = true; } };
    },
  });
  assert.equal(seen.bin, "powershell.exe");
  assert.deepEqual(seen.args, notifyArgs("t", "b"));
  assert.equal(unreffed, true);
});

test("notify: a throwing spawnFn is swallowed, never propagates (fail-open)", () => {
  assert.doesNotThrow(() => {
    notify("t", "b", { platform: "win32", spawnFn: () => { throw new Error("no powershell here"); } });
  });
});
