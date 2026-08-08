// SPEC-0006 (SL-003): the render panel -- one text input per detected
// variable, one checkbox per detected optional section. Extracted from
// index.html, which sat at NFR-009's 250-line ceiling exactly (PRD change log
// v0.1.5 flagged it for the next slice needing to extend it).
import { extractVariables, extractSections, render } from "./render.mjs";

// Split out of buildRenderPanel to hold it under NFR-009's 40-line function
// budget; each returns the control map its caller needs to read at copy time.
function addVariableInputs(panel, names) {
  const inputs = {};
  for (const name of names) {
    const label = document.createElement("label");
    label.textContent = name;
    const input = document.createElement("input");
    input.type = "text";
    label.append(input);
    panel.append(label);
    inputs[name] = input;
  }
  return inputs;
}

// Checked by default: the full prompt is the expected copy, and UC-003's
// "lean" flow is the deliberate act of unchecking.
function addSectionBoxes(panel, ids) {
  const boxes = {};
  for (const id of ids) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    label.append(box, ` ${id}`);
    panel.append(label);
    boxes[id] = box;
  }
  return boxes;
}

// An empty input is omitted from `values` entirely, so render() sees an
// absent key and its missing-variable block (AC-002 of SPEC-0003) fires --
// this is the one place "empty input" maps to "absent key".
export function buildRenderPanel(prompt, api) {
  const names = extractVariables(prompt.body);
  const ids = extractSections(prompt.body);
  if (names.length === 0 && ids.length === 0) return null;

  const panel = document.createElement("div");
  const inputs = addVariableInputs(panel, names);
  const boxes = addSectionBoxes(panel, ids);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy rendered text";
  const status = document.createElement("p");
  panel.append(copyBtn, status);

  copyBtn.addEventListener("click", async () => {
    const values = {};
    for (const name of names) {
      const value = inputs[name].value;
      if (value !== "") values[name] = value;
    }
    const startedAt = performance.now();
    const result = render(prompt.body, values, ids.filter((id) => boxes[id].checked));
    const wallClockMs = Math.round(performance.now() - startedAt);
    if (!result.ok) {
      status.textContent = `Missing: ${result.missing.join(", ")}`;
      return;
    }
    await navigator.clipboard.writeText(result.text);
    status.textContent = "Copied!";
    // SPEC-0008 (FR-011): after the confirmation, not before -- a slow or
    // failed write must never delay or block the copy FR-007 promises.
    await api("usage", { method: "POST", body: { prompt_id: prompt.id, version_no: prompt.currentVersion } });
    // SPEC-0009 (NFR-010): toolbelt's core.log_run RPC, not a direct write
    // against core.* -- this repo's own CLAUDE.md forbids that.
    await api("rpc/log_run", {
      method: "POST",
      profile: "core",
      body: { p_app_id: "prompt-organizer", p_kind: "render", p_wall_clock_ms: wallClockMs },
    });
  });

  return panel;
}
