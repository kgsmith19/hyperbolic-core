// The render/copy panel (05-d section 8's variable/section model, section 9
// rank 2's token estimate): one text input per {{VARIABLE}}, one checkbox
// per <!--OPTIONAL:id--> section (checked by default -- the full prompt is
// the expected copy, unchecking is the deliberate "lean" action), a saved-
// configuration select/save pair, and a preview+copy action. Ported from
// apps/toolbelt/apps/prompt-organizer/frontend/panel.mjs's exact behavior (same
// empty-input-means-absent-key rule, same post-confirmation fire-and-forget
// usage log) onto ../../lib/prompt-render's render()/extractVariables()/
// extractSections() -- a local copy, not @hyperbolic/llm's (see that
// package's own index.ts comment on why importing it here blew the bundle
// budget).
import { useMemo, useState } from "react";
import { Button, Input, Label, Select, SelectItem } from "@hyperbolic/ui";
import { estimateTokenCount, recordUsage, saveConfiguration, type Configuration, type Prompt } from "../../lib/prompts";
import { extractSections, extractVariables, render } from "../../lib/prompt-render";

const APPLY_CONFIG_PLACEHOLDER = "";

/** SPEC-0011 AC-001: only values for a still-present variable name apply --
 * narrows a saved configuration, never widens it with a stale name. */
function applyConfigValues(values: Record<string, string>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) if (name in values) out[name] = values[name];
  return out;
}

interface RenderPanelProps {
  prompt: Prompt;
  onConfigurationSaved?: (config: Configuration) => void;
  onUsageRecorded?: () => void;
}

function RenderPanel({ prompt, onConfigurationSaved, onUsageRecorded }: RenderPanelProps) {
  const names = useMemo(() => extractVariables(prompt.body), [prompt.body]);
  const ids = useMemo(() => extractSections(prompt.body), [prompt.body]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [sections, setSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(ids.map((id) => [id, true]))
  );
  const [configSelection, setConfigSelection] = useState(APPLY_CONFIG_PLACEHOLDER);
  const [configName, setConfigName] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);
  const [status, setStatus] = useState<{ kind: "missing" | "copied"; text: string; tokens?: number } | null>(null);

  if (names.length === 0 && ids.length === 0) {
    return null;
  }

  function applyConfig(name: string) {
    setConfigSelection(name);
    const config = prompt.configurations.find((c) => c.name === name);
    if (!config) return;
    setValues((prev) => ({ ...prev, ...applyConfigValues(config.values, names) }));
    setSections(Object.fromEntries(ids.map((id) => [id, config.sections.includes(id)])));
  }

  async function handleSaveConfiguration() {
    const name = configName.trim();
    if (!name) return;
    setSavingConfig(true);
    try {
      const configValues: Record<string, string> = {};
      for (const n of names) if (values[n]) configValues[n] = values[n];
      const includedSections = ids.filter((id) => sections[id]);
      const saved = await saveConfiguration(prompt.id, name, configValues, includedSections);
      onConfigurationSaved?.(saved);
      setConfigName("");
    } finally {
      setSavingConfig(false);
    }
  }

  async function handlePreviewAndCopy() {
    const includedSections = ids.filter((id) => sections[id]);
    // An empty input maps to an ABSENT key (not an empty-string value), so
    // render()'s missing-variable check fires for it -- the one place
    // "empty input" means "missing", matching panel.mjs's addCopyControl.
    const renderValues: Record<string, string | undefined> = {};
    for (const name of names) {
      renderValues[name] = values[name] ? values[name] : undefined;
    }
    const result = render(prompt.body, renderValues, includedSections);
    if (!result.ok) {
      setStatus({ kind: "missing", text: `Missing: ${result.missing.join(", ")}` });
      return;
    }
    await navigator.clipboard.writeText(result.text);
    setStatus({ kind: "copied", text: result.text, tokens: estimateTokenCount(result.text) });
    // Fire-and-forget, after the confirmation is already shown (05-d
    // section 1.2: "never blocking" the copy path) -- a failed usage log
    // must never retract the "Copied!" state above.
    recordUsage(prompt.id, prompt.currentVersionNo, 0)
      .then(() => onUsageRecorded?.())
      .catch(() => {});
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3" data-testid="render-panel">
      {names.length > 0 && (
        <div className="flex flex-col gap-2">
          {names.map((name) => (
            <div key={name} className="flex flex-col gap-1">
              <Label htmlFor={`var-${prompt.id}-${name}`}>{name}</Label>
              <Input
                id={`var-${prompt.id}-${name}`}
                data-testid={`render-variable-${name}`}
                value={values[name] ?? ""}
                onChange={(event) => setValues((prev) => ({ ...prev, [name]: event.target.value }))}
              />
            </div>
          ))}
        </div>
      )}

      {ids.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="render-sections">
          {ids.map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                className="accent-accent size-4"
                checked={sections[id] ?? true}
                onChange={(event) => setSections((prev) => ({ ...prev, [id]: event.target.checked }))}
                data-testid={`render-section-${id}`}
              />
              {id}
            </label>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={configSelection}
          onChange={(event) => applyConfig(event.target.value)}
          wrapperClassName="max-w-56"
          data-testid="render-config-select"
        >
          <SelectItem value={APPLY_CONFIG_PLACEHOLDER}>Apply a saved configuration...</SelectItem>
          {prompt.configurations.map((config) => (
            <SelectItem key={config.name} value={config.name}>
              {config.name}
            </SelectItem>
          ))}
        </Select>
        <Input
          placeholder="configuration name"
          value={configName}
          onChange={(event) => setConfigName(event.target.value)}
          className="max-w-48"
          data-testid="render-config-name"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleSaveConfiguration}
          disabled={savingConfig || !configName.trim()}
          data-testid="render-save-config"
        >
          Save as configuration
        </Button>
      </div>

      <Button type="button" size="sm" onClick={handlePreviewAndCopy} data-testid="render-preview-copy" className="w-fit">
        Preview &amp; copy rendered text
      </Button>

      {status?.kind === "missing" && (
        <p className="text-sm text-danger" data-testid="render-status-missing">
          {status.text}
        </p>
      )}
      {status?.kind === "copied" && (
        <div className="flex flex-col gap-1" data-testid="render-status-copied">
          <p className="text-sm text-accent">Copied!</p>
          <pre className="max-h-48 overflow-auto rounded-lg bg-bg-subtle p-3 text-xs whitespace-pre-wrap text-text-secondary">
            {status.text}
          </pre>
          <p className="text-xs text-text-secondary" data-testid="render-token-estimate">
            ~{status.tokens} tokens (estimate)
          </p>
        </div>
      )}
    </div>
  );
}

export { RenderPanel, applyConfigValues };
