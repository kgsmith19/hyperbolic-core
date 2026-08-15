// Fake hooks/usage.mjs for the spending-tab e2e (SPEC-0004). Sandbox only.
const a = process.argv.slice(2);
if (a[0] === "check") console.log(JSON.stringify({ tier: "amber", pct: 60, weekTokens: 1200000, redTokens: 2000000 }));
else if (a[0] === "week") console.log("TOTAL  $12.34  (last 7 days)");
