// /ideas/new and /ideas/:id (05-h section 8): "Same fields [across create
// and existing]. Action set varies by status: draft shows Save / Promote to
// idea / Delete / Optimize; idea shows Save / Submit to GitHub / Optimize
// (Demote is absent by design); submitted renders fully read-only with
// exactly one action, 'Optimize as new derivative', plus the issue link."
// Optimize is a disabled placeholder everywhere (m4-06 wires it up).
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ExternalLink } from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  InlineError,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Spinner,
  Textarea,
  useDelayedVisible,
} from "@hyperbolic/ui";
import {
  createDraft,
  deleteIdea,
  getIdea,
  buildSubmitPreview,
  submitIdea,
  updateIdea,
  type Confidence,
  type Idea,
} from "../../lib/intake";
import { useAsync } from "../../lib/use-async";

const TARGET_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface FormState {
  title: string;
  problem: string;
  outcome: string;
  notes: string;
  confidence: Confidence;
  source: string;
  targetRepo: string;
}

function toFormState(idea?: Idea | null): FormState {
  return {
    title: idea?.title ?? "",
    problem: idea?.problem ?? "",
    outcome: idea?.outcome ?? "",
    notes: idea?.notes ?? "",
    confidence: idea?.confidence ?? "medium",
    source: idea?.source ?? "",
    targetRepo: idea?.targetRepo ?? "",
  };
}

function EditorSkeleton() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6" data-testid="idea-editor-skeleton">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

function ConfidenceField({ value, onChange, disabled }: { value: Confidence; onChange: (next: Confidence) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Confidence</Label>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as Confidence)}
        disabled={disabled}
        data-testid="idea-confidence-field"
        className="flex flex-row gap-4"
      >
        {(["low", "medium", "high"] as Confidence[]).map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm text-text">
            <RadioGroupItem value={option} data-testid={`idea-confidence-${option}`} />
            {option}
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

function SubmitModal({
  idea,
  open,
  onOpenChange,
  onSubmitted,
}: {
  idea: Idea;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: (issueNumber: number, issueUrl: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = buildSubmitPreview(idea);

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      const result = await submitIdea(idea.id);
      if (result.kind === "ok") {
        onSubmitted(result.issueNumber, result.issueUrl);
        onOpenChange(false);
        return;
      }
      if (result.kind === "draft_not_promoted") {
        setError("This idea is still a draft; promote it before submitting.");
      } else if (result.kind === "unauthorized") {
        setError("Your session is no longer valid. Sign in again and retry.");
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="submit-confirmation-modal">
        <DialogHeader>
          <DialogTitle>Submit to GitHub</DialogTitle>
          <DialogDescription>
            This creates exactly one GitHub Issue. The app can never edit or close it afterward.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">Title</p>
            <p className="text-sm text-text" data-testid="submit-preview-title">
              {preview.title}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">Body</p>
            <pre
              data-testid="submit-preview-body"
              className="max-h-48 overflow-auto rounded-lg bg-bg-subtle p-3 text-xs whitespace-pre-wrap text-text-secondary"
            >
              {preview.body}
            </pre>
          </div>
          <div className="flex flex-wrap gap-1.5" data-testid="submit-preview-labels">
            {preview.labels.map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))}
          </div>
          {error && <InlineError message={error} data-testid="submit-error" />}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button onClick={handleConfirm} disabled={pending} data-testid="submit-confirm-button">
            {pending && <Spinner />} Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubmittedView({ idea }: { idea: Idea }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6" data-testid="idea-editor-page">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold text-text">{idea.title}</h2>
        <Badge variant="secondary">Submitted</Badge>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border p-4 text-sm text-text">
        <p className="whitespace-pre-wrap">{idea.problem}</p>
        <p className="whitespace-pre-wrap">{idea.outcome}</p>
        {idea.notes && <p className="whitespace-pre-wrap text-text-secondary">{idea.notes}</p>}
        <p className="text-text-secondary">
          Confidence: {idea.confidence}. Source: {idea.source || "n/a"}.
        </p>
      </div>
      {idea.githubIssueUrl && (
        <a
          href={idea.githubIssueUrl}
          target="_blank"
          rel="noreferrer"
          data-testid="idea-issue-link"
          className="inline-flex w-fit items-center gap-1 text-sm text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Issue #{idea.githubIssueNumber} <ExternalLink className="size-3.5" />
        </a>
      )}
      <Button variant="outline" disabled data-testid="optimize-derivative-button" className="w-fit">
        Optimize as new derivative
      </Button>
    </div>
  );
}

function IdeaEditorPage({ mode }: { mode: "create" | "edit" }) {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const ideaId = mode === "edit" ? (params.id ?? "") : "";

  const { status, data: loaded, errorMessage, retry } = useAsync(
    () => (mode === "edit" ? getIdea(ideaId) : Promise.resolve(null)),
    [mode, ideaId]
  );
  const showSkeleton = useDelayedVisible(mode === "edit" && status === "loading");

  const [idea, setIdea] = useState<Idea | null>(null);
  const [form, setForm] = useState<FormState>(toFormState());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);

  useEffect(() => {
    if (mode === "edit" && loaded) {
      setIdea(loaded);
      setForm(toFormState(loaded));
    }
  }, [mode, loaded]);

  function patchForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSaveDraft() {
    if (!form.title.trim()) {
      setFormError("Title is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (mode === "create") {
        const created = await createDraft({
          title: form.title,
          problem: form.problem,
          outcome: form.outcome,
          notes: form.notes,
          confidence: form.confidence,
          source: form.source,
        });
        navigate(`/ideas/${created.id}`);
        return;
      }
      const updated = await updateIdea(ideaId, {
        title: form.title,
        problem: form.problem,
        outcome: form.outcome,
        notes: form.notes,
        confidence: form.confidence,
        source: form.source,
        ...(idea?.status === "draft" ? { targetRepo: form.targetRepo || null } : {}),
      });
      setIdea(updated);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePromote() {
    if (!TARGET_REPO_RE.test(form.targetRepo.trim())) {
      setFormError("Target repo must look like owner/repo before promoting.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const updated = await updateIdea(ideaId, {
        title: form.title,
        problem: form.problem,
        outcome: form.outcome,
        notes: form.notes,
        confidence: form.confidence,
        source: form.source,
        targetRepo: form.targetRepo,
        status: "idea",
      });
      setIdea(updated);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Promote failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    setFormError(null);
    try {
      await deleteIdea(ideaId);
      navigate("/ideas");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Delete failed.");
      setSaving(false);
    }
  }

  if (mode === "edit" && status === "error") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState title="Could not load this idea" message={errorMessage ?? undefined} onRetry={retry} />
      </div>
    );
  }

  if (mode === "edit" && status === "loading") {
    return showSkeleton ? <EditorSkeleton /> : null;
  }

  if (mode === "edit" && !idea) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState title="Idea not found" message="It may have been deleted, or you no longer have access." />
      </div>
    );
  }

  if (idea?.status === "submitted_to_github") {
    return <SubmittedView idea={idea} />;
  }

  const isDraft = mode === "create" || idea?.status === "draft";

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6" data-testid="idea-editor-page">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-semibold text-text">{mode === "create" ? "New idea" : idea?.title || "Edit idea"}</h2>
        {idea && <Badge variant={idea.status === "draft" ? "secondary" : "default"}>{idea.status === "draft" ? "Draft" : "Idea"}</Badge>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="idea-title">Title</Label>
        <Input
          id="idea-title"
          data-testid="idea-title-field"
          value={form.title}
          onChange={(event) => patchForm("title", event.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="idea-problem">Problem</Label>
        <Textarea
          id="idea-problem"
          data-testid="idea-problem-field"
          value={form.problem}
          onChange={(event) => patchForm("problem", event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="idea-outcome">Desired outcome</Label>
        <Textarea
          id="idea-outcome"
          data-testid="idea-outcome-field"
          value={form.outcome}
          onChange={(event) => patchForm("outcome", event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="idea-notes">Notes</Label>
        <Textarea
          id="idea-notes"
          data-testid="idea-notes-field"
          value={form.notes}
          onChange={(event) => patchForm("notes", event.target.value)}
        />
      </div>

      <ConfidenceField value={form.confidence} onChange={(next) => patchForm("confidence", next)} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="idea-source">Source</Label>
        <Input
          id="idea-source"
          data-testid="idea-source-field"
          value={form.source}
          onChange={(event) => patchForm("source", event.target.value)}
        />
      </div>

      {isDraft && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="idea-target-repo">Target repo</Label>
          <Input
            id="idea-target-repo"
            data-testid="idea-target-repo-field"
            placeholder="owner/repo"
            value={form.targetRepo}
            onChange={(event) => patchForm("targetRepo", event.target.value)}
          />
        </div>
      )}
      {!isDraft && form.targetRepo && (
        <p className="text-sm text-text-secondary" data-testid="idea-target-repo-readonly">
          Target repo: {form.targetRepo}
        </p>
      )}

      {formError && <InlineError message={formError} data-testid="idea-form-error" />}

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button onClick={handleSaveDraft} disabled={saving} data-testid="save-idea-button">
          {saving && <Spinner />} Save
        </Button>
        {isDraft && mode === "edit" && (
          <Button onClick={handlePromote} disabled={saving} variant="outline" data-testid="promote-idea-button">
            Promote to idea
          </Button>
        )}
        {idea?.status === "idea" && (
          <Button onClick={() => setSubmitOpen(true)} disabled={saving} variant="outline" data-testid="submit-idea-button">
            Submit to GitHub
          </Button>
        )}
        {isDraft && mode === "edit" && (
          <Button onClick={handleDelete} disabled={saving} variant="destructive" data-testid="delete-idea-button">
            Delete
          </Button>
        )}
        <Button variant="ghost" disabled data-testid="optimize-idea-button">
          Optimize
        </Button>
        <Button variant="ghost" render={<Link to="/ideas" />} className="ml-auto">
          Back to list
        </Button>
      </div>

      {idea?.status === "idea" && (
        <SubmitModal
          idea={idea}
          open={submitOpen}
          onOpenChange={setSubmitOpen}
          onSubmitted={(issueNumber, issueUrl) =>
            setIdea((prev) =>
              prev
                ? { ...prev, status: "submitted_to_github", githubIssueNumber: issueNumber, githubIssueUrl: issueUrl }
                : prev
            )
          }
        />
      )}
    </div>
  );
}

export default IdeaEditorPage;
