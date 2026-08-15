// The render panel creates one text input per detected variable and one
// checkbox per detected optional section. It is separate from index.html to
// preserve the documented modularity boundary.
import { extractVariables, extractSections, render } from "./render.mjs";

// SPEC-0011 AC-001: only values for a still-present variable name apply --
// narrows a saved configuration, never widens it with a stale name.
export function applyConfigValues(values, names) {
  const out = {};
  for (const name of names) if (name in values) out[name] = values[name];
  return out;
}

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

// A select to apply a saved configuration, plus a name-and-save control
// (SPEC-0011). Split out for the same 40-line-function reason as its siblings.
function addConfigControls(panel, prompt, inputs, boxes, names, ids, api) {
  const configs = prompt.configurations ?? [];
  const select = document.createElement("select");
  select.append(new Option("Apply a saved configuration...", ""));
  for (const c of configs) select.append(new Option(c.name, c.name));
  select.addEventListener("change", () => {
    const c = configs.find((c) => c.name === select.value);
    if (!c) return;
    const values = applyConfigValues(c.values, names);
    for (const name in values) inputs[name].value = values[name];
    for (const id of ids) boxes[id].checked = c.sections.includes(id);
  });

  const nameInput = document.createElement("input");
  nameInput.placeholder = "configuration name";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save as configuration";
  saveBtn.addEventListener("click", async () => {
    if (nameInput.value === "") return;
    const values = {};
    for (const name of names) if (inputs[name].value !== "") values[name] = inputs[name].value;
    const sections = ids.filter((id) => boxes[id].checked);
    const [saved] = await api("configuration", {
      method: "POST", body: { prompt_id: prompt.id, name: nameInput.value, values, sections },
    });
    configs.push(saved);
    select.append(new Option(saved.name, saved.name));
    nameInput.value = "";
  });

  panel.append(select, nameInput, saveBtn);
}

// The copy button: renders with the current inputs, copies on success, logs
// usage after the confirmation (SPEC-0008 FR-011). An empty input is omitted
// from `values` entirely, so render() sees an absent key and its
// missing-variable block (AC-002 of SPEC-0003) fires -- this is the one
// place "empty input" maps to "absent key". Split out for the same
// 40-line-function reason as its siblings.
function addCopyControl(panel, prompt, api, names, inputs, ids, boxes) {
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
}

export function buildRenderPanel(prompt, api) {
  const names = extractVariables(prompt.body);
  const ids = extractSections(prompt.body);
  if (names.length === 0 && ids.length === 0) return null;

  const panel = document.createElement("div");
  const inputs = addVariableInputs(panel, names);
  const boxes = addSectionBoxes(panel, ids);
  addConfigControls(panel, prompt, inputs, boxes, names, ids, api);
  addCopyControl(panel, prompt, api, names, inputs, ids, boxes);

  return panel;
}
