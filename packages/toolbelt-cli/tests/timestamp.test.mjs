import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp, nextTimestamp } from "../src/timestamp.mjs";

test("formatTimestamp produces a 14-digit UTC YYYYMMDDHHmmss string", () => {
  const ts = formatTimestamp(new Date(Date.UTC(2026, 7, 12, 23, 5, 9))); // month is 0-indexed: 7 = August
  assert.equal(ts, "20260812230509");
  assert.match(ts, /^\d{14}$/);
});

test("nextTimestamp returns the formatted `from` time when no existing file claims it", () => {
  const from = new Date(Date.UTC(2026, 7, 12, 12, 0, 0));
  assert.equal(nextTimestamp([], from), "20260812120000");
  assert.equal(nextTimestamp(["20260101000000_something.sql"], from), "20260812120000");
});

test("nextTimestamp bumps by one second, repeatedly, until it finds a free prefix", () => {
  const from = new Date(Date.UTC(2026, 7, 12, 12, 0, 0));
  const existing = [
    "20260812120000_register_a.sql",
    "20260812120000_register_a_down.sql",
    "20260812120001_register_b.sql",
    "20260812120001_register_b_down.sql",
  ];
  assert.equal(nextTimestamp(existing, from), "20260812120002");
});

test("nextTimestamp only consults the leading digit run before the first underscore (matches validate-migrations.mjs's own version-key convention)", () => {
  const from = new Date(Date.UTC(2026, 7, 12, 12, 0, 0));
  // A file with no leading digits (malformed / irrelevant) must not crash or
  // spuriously collide.
  assert.equal(nextTimestamp(["README.md", "notes.sql"], from), "20260812120000");
});
