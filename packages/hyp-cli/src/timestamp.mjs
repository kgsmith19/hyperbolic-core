// UTC migration-filename timestamps, matching the toolbelt convention
// (14-digit YYYYMMDDHHmmss prefix, e.g. 20260812250000). nextTimestamp
// guarantees a value that does not collide with any existing migration
// filename's version prefix in the given directory, which is what
// apps/toolbelt/scripts/validate-migrations.mjs's checkVersionCollisions
// requires (no two migration files across the checked directories may share
// a version key).
function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

export function formatTimestamp(date) {
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}

// existingBasenames: filenames already present in the target directory
// (up and down files both fine to pass in; only the leading digit run
// before the first "_" is consulted, same convention
// validate-migrations.mjs's checkVersionCollisions uses).
export function nextTimestamp(existingBasenames, from = new Date()) {
  const taken = new Set();
  for (const name of existingBasenames) {
    const match = /^(\d+)_/.exec(name);
    if (match) taken.add(match[1]);
  }
  let candidate = new Date(from.getTime());
  let ts = formatTimestamp(candidate);
  // `latest` must consider only genuine 14-digit timestamps. The catch-up
  // branch below parses it by fixed 14-wide slices, so feeding it a digit run
  // of any other length yields a wrong-but-plausible date rather than an
  // error: a "999" version produced version "9981130000001" (13 digits, year
  // 998), and a 16-digit one produced 15 digits. Neither collides, so nothing
  // downstream objected -- the CLI would simply have written a migration whose
  // version violates the convention it exists to uphold. Only a genuine
  // 14-digit timestamp is a valid input to that arithmetic.
  //
  // `taken` still holds every digit run, matching validate-migrations.mjs's
  // own `/^\d+$/` test (this repo carries real 4-digit versions like
  // 0001_init.sql). That is belt-and-braces rather than load-bearing:
  // formatTimestamp always emits 14 digits, so a shorter or longer version
  // can never equal a generated one. Keeping them costs nothing and keeps
  // this set's definition identical to the validator's.
  const latest = [...taken].filter((v) => v.length === 14).sort().at(-1);
  if (latest && ts <= latest) {
    if (latest === "99991231235959") {
      throw new Error("migration version space exhausted after 99991231235959");
    }
    const year = Number(latest.slice(0, 4));
    const month = Number(latest.slice(4, 6)) - 1;
    const day = Number(latest.slice(6, 8));
    const hour = Number(latest.slice(8, 10));
    const minute = Number(latest.slice(10, 12));
    const second = Number(latest.slice(12, 14)) + 1;
    candidate = new Date(Date.UTC(year, month, day, hour, minute, second));
    ts = formatTimestamp(candidate);
  }
  while (taken.has(ts)) {
    candidate = new Date(candidate.getTime() + 1000);
    ts = formatTimestamp(candidate);
  }
  return ts;
}
