// One prompt, expandable in place -- the same interaction model
// apps/toolbelt/apps/prompt-organizer/web/index.html's showPrompt() already
// established (a <details> per row), extended with m5-02's body-edit UI,
// rename refusal for namespaced prompts, and the usage-count badge.
import { useState } from "react";
import { Badge, Button, InlineError, Input, Label, Spinner, Textarea } from "@hyperbolic/ui";
import {
  addTags,
  estimateTokenCount,
  parseTagInput,
  setArchived,
  updateBody,
  updateTitle,
  type Prompt,
} from "../../lib/prompts";
import { isNamespacedTitle } from "../../lib/prompt-namespace";
import { RenderPanel } from "./render-panel";
import { VersionHistory } from "./version-history";

interface PromptCardProps {
  prompt: Prompt;
  onChanged: (updated: Prompt) => void;
  selectedTag: string | null;
  onTagClick: (tag: string) => void;
}

function PromptCard({ prompt, onChanged, selectedTag, onTagClick }: PromptCardProps) {
  const namespaced = isNamespacedTitle(prompt.title);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(prompt.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [savingTitle, setSavingTitle] = useState(false);

  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(prompt.body);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [savingBody, setSavingBody] = useState(false);

  const [tagInput, setTagInput] = useState("");
  const [savingTags, setSavingTags] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);

  const [archiving, setArchiving] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState(false);

  async function handleSaveTitle() {
    setSavingTitle(true);
    setTitleError(null);
    try {
      const updated = await updateTitle(prompt.id, titleDraft);
      onChanged(updated);
      setEditingTitle(false);
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : "Failed to rename.");
    } finally {
      setSavingTitle(false);
    }
  }

  async function handleSaveBody() {
    setSavingBody(true);
    setBodyError(null);
    try {
      const updated = await updateBody(prompt.id, bodyDraft);
      onChanged(updated);
      setEditingBody(false);
    } catch (err) {
      setBodyError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSavingBody(false);
    }
  }

  async function handleRestore(body: string) {
    setRestoringVersion(true);
    try {
      const updated = await updateBody(prompt.id, body);
      onChanged(updated);
      setBodyDraft(updated.body);
    } finally {
      setRestoringVersion(false);
    }
  }

  async function handleAddTags() {
    const tags = parseTagInput(tagInput).filter((tag) => !prompt.tags.includes(tag));
    if (tags.length === 0) {
      setTagInput("");
      return;
    }
    setSavingTags(true);
    setTagError(null);
    try {
      await addTags(prompt.id, tags);
      onChanged({ ...prompt, tags: [...prompt.tags, ...tags] });
      setTagInput("");
    } catch (err) {
      setTagError(err instanceof Error ? err.message : "Failed to add tags.");
    } finally {
      setSavingTags(false);
    }
  }

  async function handleArchiveToggle() {
    setArchiving(true);
    try {
      const updated = await setArchived(prompt.id, !prompt.isActive);
      onChanged(updated);
    } finally {
      setArchiving(false);
    }
  }

  return (
    <li className="rounded-xl ring-1 ring-text/10" data-testid="prompt-card" data-prompt-id={prompt.id} data-status={prompt.isActive ? "active" : "archived"}>
      <details className="p-4">
        <summary className="flex cursor-pointer flex-wrap items-center gap-2" data-testid="prompt-summary">
          <span className="font-medium text-text" data-testid="prompt-title">
            {prompt.title}
          </span>
          {!prompt.isActive && <Badge variant="secondary">Archived</Badge>}
          <Badge variant="secondary" data-testid="prompt-usage-badge">
            {prompt.usageCount} {prompt.usageCount === 1 ? "use" : "uses"}
          </Badge>
          <span className="text-xs text-text-secondary" data-testid="prompt-token-estimate">
            ~{estimateTokenCount(prompt.body)} tokens (estimate)
          </span>
          {prompt.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              data-testid="tag-chip"
              aria-pressed={tag === selectedTag}
              data-selected={tag === selectedTag}
              onClick={(event) => {
                event.preventDefault();
                onTagClick(tag);
              }}
            >
              <Badge variant={tag === selectedTag ? "default" : "secondary"}>{tag}</Badge>
            </button>
          ))}
        </summary>

        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>Title</Label>
              {!editingTitle && !namespaced && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditingTitle(true)} data-testid="edit-title-button">
                  Rename
                </Button>
              )}
            </div>
            {editingTitle ? (
              <div className="flex flex-col gap-1.5">
                <Input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} data-testid="title-field" />
                {titleError && <InlineError message={titleError} data-testid="title-error" />}
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={handleSaveTitle} disabled={savingTitle} data-testid="save-title-button">
                    {savingTitle && <Spinner />} Save
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => { setEditingTitle(false); setTitleDraft(prompt.title); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              namespaced && (
                <p className="text-xs text-text-secondary" data-testid="rename-refused-note">
                  This name is namespaced and used by other consumers -- create a new prompt and archive this one to rename it.
                </p>
              )
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label>Body</Label>
              {!editingBody && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditingBody(true)} data-testid="edit-body-button">
                  Edit
                </Button>
              )}
            </div>
            {editingBody ? (
              <div className="flex flex-col gap-1.5">
                <Textarea value={bodyDraft} onChange={(e) => setBodyDraft(e.target.value)} rows={8} data-testid="body-field" />
                {bodyError && <InlineError message={bodyError} data-testid="body-error" />}
                <div className="flex gap-2">
                  <Button type="button" size="sm" onClick={handleSaveBody} disabled={savingBody} data-testid="save-body-button">
                    {savingBody && <Spinner />} Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingBody(false);
                      setBodyDraft(prompt.body);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <pre className="max-h-64 overflow-auto rounded-lg bg-bg-subtle p-3 text-sm whitespace-pre-wrap text-text" data-testid="prompt-body">
                {prompt.body}
              </pre>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Add tags</Label>
            <div className="flex gap-2">
              <Input
                placeholder="comma, separated, tags"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                className="max-w-64"
                data-testid="add-tags-field"
              />
              <Button type="button" variant="outline" size="sm" onClick={handleAddTags} disabled={savingTags} data-testid="add-tags-button">
                Add tags
              </Button>
            </div>
            {tagError && <InlineError message={tagError} data-testid="tags-error" />}
          </div>

          <RenderPanel
            prompt={prompt}
            onConfigurationSaved={(config) => onChanged({ ...prompt, configurations: [...prompt.configurations, config] })}
            onUsageRecorded={() => onChanged({ ...prompt, usageCount: prompt.usageCount + 1 })}
          />

          <VersionHistory prompt={prompt} onRestore={handleRestore} restoring={restoringVersion} />

          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleArchiveToggle}
              disabled={archiving}
              data-testid="archive-toggle-button"
            >
              {archiving && <Spinner />} {prompt.isActive ? "Archive" : "Unarchive"}
            </Button>
          </div>
        </div>
      </details>
    </li>
  );
}

export { PromptCard };
