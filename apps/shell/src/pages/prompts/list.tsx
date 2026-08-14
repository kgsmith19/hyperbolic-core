// /prompts (05-d-prompt-organizer.md, ADR-01/ADR-02: "the Shell absorbs...
// the Toolbelt tool UIs"). Same interaction model
// apps/toolbelt/apps/prompt-organizer/web/index.html already established
// (a save form, a searchable/filterable list of expandable rows) ported
// onto Shell session/PostgREST conventions and packages/ui primitives, with
// m5-02's additions: usage badge, token estimate, body-edit-in-place, and
// rename refusal for namespaced titles (owned by ./prompt-card.tsx).
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  Input,
  InlineError,
  Label,
  Skeleton,
  Spinner,
  Textarea,
  useDelayedVisible,
} from "@hyperbolic/ui";
import { createPrompt, listPrompts, parseTagInput, type Prompt } from "../../lib/prompts";
import { filterByActive, searchPrompts, shouldFocusSearch, toggleTagFilter } from "../../lib/prompt-search";
import { useAsync } from "../../lib/use-async";
import { PromptCard } from "./prompt-card";

function ListSkeleton() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6" data-testid="prompts-list-skeleton">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-9 w-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  );
}

interface NewPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (prompt: Prompt) => void;
}

function NewPromptDialog({ open, onOpenChange, onCreated }: NewPromptDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setBody("");
      setTags("");
      setError(null);
    }
  }, [open]);

  async function handleSave() {
    if (!title.trim() || !body.trim()) {
      setError("Title and body are both required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await createPrompt({ title: title.trim(), body, tags: parseTagInput(tags) });
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-prompt-dialog">
        <DialogHeader>
          <DialogTitle>New prompt</DialogTitle>
          <DialogDescription>Every save is versioned from the start (version 1).</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-prompt-title">Title</Label>
            <Input id="new-prompt-title" data-testid="new-prompt-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-prompt-body">Body</Label>
            <Textarea id="new-prompt-body" data-testid="new-prompt-body" value={body} onChange={(e) => setBody(e.target.value)} rows={6} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-prompt-tags">Tags</Label>
            <Input
              id="new-prompt-tags"
              data-testid="new-prompt-tags"
              placeholder="comma, separated, tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          {error && <InlineError message={error} data-testid="new-prompt-error" />}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={saving} />}>Cancel</DialogClose>
          <Button onClick={handleSave} disabled={saving} data-testid="new-prompt-save">
            {saving && <Spinner />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromptsListPage() {
  const { status, data, errorMessage, retry } = useAsync(listPrompts);
  const showSkeleton = useDelayedVisible(status === "loading");
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [query, setQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [newPromptOpen, setNewPromptOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (data) setPrompts(data);
  }, [data]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (shouldFocusSearch(event.key, target?.tagName ?? "")) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const filtered = useMemo(() => {
    const byActive = filterByActive(prompts, showArchived);
    const byTag = selectedTag === null ? byActive : byActive.filter((p) => p.tags.includes(selectedTag));
    return searchPrompts(byTag, query);
  }, [prompts, showArchived, selectedTag, query]);

  function handleChanged(updated: Prompt) {
    setPrompts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  function handleCreated(created: Prompt) {
    setPrompts((prev) => [created, ...prev]);
  }

  if (status === "error") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState title="Could not load prompts" message={errorMessage ?? undefined} onRetry={retry} />
      </div>
    );
  }

  if (status === "loading") {
    return showSkeleton ? <ListSkeleton /> : null;
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6" data-testid="prompts-list-page">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-text">Prompts</h2>
          <p className="mt-1 text-sm text-text-secondary">The system's prompt store: search, render, and version.</p>
        </div>
        <Button size="sm" onClick={() => setNewPromptOpen(true)} data-testid="new-prompt-button">
          <Plus /> New prompt
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Input
          ref={searchRef}
          type="search"
          placeholder="Search title, tags, or body (press / to focus)"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="prompts-search"
          className="sm:max-w-md"
          aria-label="Search prompts"
        />
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            className="accent-accent size-4"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            data-testid="show-archived-toggle"
          />
          Show archived
        </label>
      </div>

      {selectedTag && (
        <button
          type="button"
          className="w-fit text-xs text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => setSelectedTag(null)}
          data-testid="clear-tag-filter"
        >
          Filtering by tag &quot;{selectedTag}&quot; -- clear
        </button>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Plus />}
          title={prompts.length === 0 ? "No prompts yet." : "No prompts match this filter."}
          action={
            prompts.length === 0 ? (
              <Button size="sm" variant="outline" onClick={() => setNewPromptOpen(true)}>
                Save your first prompt
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="prompts-rows">
          {filtered.map((prompt) => (
            <PromptCard
              key={prompt.id}
              prompt={prompt}
              onChanged={handleChanged}
              selectedTag={selectedTag}
              onTagClick={(tag) => setSelectedTag((current) => toggleTagFilter(current, tag))}
            />
          ))}
        </ul>
      )}

      <NewPromptDialog open={newPromptOpen} onOpenChange={setNewPromptOpen} onCreated={handleCreated} />
    </div>
  );
}

export default PromptsListPage;
