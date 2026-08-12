import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hooksDir = path.dirname(fileURLToPath(import.meta.url));

test("active hooks do not inject repository-process mandates", () => {
  const activeHooks = fs.readdirSync(hooksDir)
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  assert.ok(activeHooks.length > 5, "sanity: scan the active hook surface");

  for (const name of activeHooks) {
    const source = fs.readFileSync(path.join(hooksDir, name), "utf8");
    assert.doesNotMatch(
      source,
      /RED FIRST|Test contract|the plan MUST|TIERS.*GATES|Do not ask permission|Act on it now, silently|\/(?:diff|sec-diff|lean)-review|default checks|implementation work (?:goes|belongs)/i,
      `${name} contains a mandatory repository-process contract`,
    );
  }
});
