import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const POLICY_PATH = process.env.ACC_POLICY || path.join(HERE, "..", "policy.json");
const DEFAULT_RATES = {
  opus: { in: 15, out: 75 },
  sonnet: { in: 3, out: 15 },
  fable: { in: 3, out: 15 },
  haiku: { in: 0.8, out: 4 },
  unknown: { in: 3, out: 15 },
};

function family(model) {
  if (!model) return "unknown";
  const m = String(model).toLowerCase();
  for (const f of ["opus", "sonnet", "haiku", "fable"]) if (m.includes(f)) return f;
  return "unknown";
}

function loadRates() {
  try {
    const p = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8").replace(/^\uFEFF/, ""));
    return { ...DEFAULT_RATES, ...(p.rates || {}) };
  } catch {
    return DEFAULT_RATES;
  }
}

function costOf(u, model, rates) {
  const r = rates[family(model)] || rates.unknown;
  return ((u.input * r.in) + (u.output * r.out)) / 1e6;
}

function addFile(file, totals, rates) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    if (!line || line.charCodeAt(0) !== 123) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "assistant" || !o.message?.usage) continue;
    const usage = o.message.usage;
    const input =
      (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0);
    const output = usage.output_tokens || 0;
    totals.turns += 1;
    totals.tokens += input + output;
    totals.dollars += costOf({ input, output }, o.message.model, rates);
  }
}

export function directiveSpend(sessionIds = []) {
  const want = new Set((sessionIds || []).map((id) => String(id || "")).filter(Boolean));
  const totals = { turns: 0, tokens: 0, dollars: 0 };
  if (!want.size) return totals;

  const rates = loadRates();
  let projects = [];
  try { projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return totals; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, project.name);
    for (const sid of want) {
      addFile(path.join(dir, `${sid}.jsonl`), totals, rates);
      let subFiles = [];
      try {
        subFiles = fs.readdirSync(path.join(dir, sid, "subagents"))
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => path.join(dir, sid, "subagents", f));
      } catch {}
      for (const file of subFiles) addFile(file, totals, rates);
    }
  }
  return totals;
}
