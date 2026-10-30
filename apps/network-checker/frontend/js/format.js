// Formatting helpers shared by every renderer. Pure functions only — no DOM,
// no state — so each one is trivial to reason about in isolation.

export function ms(v) {
  return v === null || v === undefined ? "—" : `${Math.round(v)} ms`;
}

export function when(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function label(state) {
  return state === "ok" ? "OK" : state === "fail" ? "FAIL" : "n/a";
}

export function tone(state) {
  return state === "ok" ? "t-ok" : state === "fail" ? "t-fail" : "t-una";
}

// Not an actual title-case (no capitalization) -- just makes an
// underscored verdict/cause id ("router_dns") readable as prose.
export function humanize(s) {
  return (s || "").replace(/_/g, " ");
}

/** RFC 4180-ish CSV field escaping: quote only when the field needs it. */
export function csvField(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(",")];
  for (const row of rows) lines.push(cols.map((c) => csvField(row[c])).join(","));
  return lines.join("\n");
}
