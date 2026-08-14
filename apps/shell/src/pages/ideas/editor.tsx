// /ideas/new and /ideas/:id (05-h section 8): "Same fields [across create
// and existing]. Action set varies by status: draft shows Save / Promote to
// idea / Delete / Optimize; idea shows Save / Submit to GitHub / Optimize
// (Demote is absent by design); submitted renders fully read-only with
// exactly one action, 'Optimize as new derivative', plus the issue link."
// Optimize is wired to lib/optimize.ts (m4-06): draft/idea offers
// apply-in-place, submitted offers derivative-only INSERT (II-3b) -- never
// a direct mutation of a submitted row (the idea_guard_update trigger
// would reject it server-side regardless).
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
import { optimizeIdea, type OptimizedDraft } from "../../lib/optimize";
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

/** Review modal shared by both optimize entry points (draft/idea's
 * apply-in-place and submitted's create-derivative): runs the LLM call on
 * open, shows the resulting draft once it resolves, and only writes
 * anything to the database when the operator explicitly confirms --
 * `optimizeIdea` itself already logged the intake.optimization row by the
 * time this dialog has anything to show, regardless of whether the
 * operator goes on to confirm or cancel (lib/optimize.ts's own header
 * comment on why that logging is unconditional). `confirmLabel` and
 * `onConfirm` vary by call site: apply-in-place vs. derivative INSERT. */
function OptimizeModal({
  idea,
  open,
  onOpenChange,
  confirmLabel,
  onConfirm,
}: {
  idea: Idea;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  confirmLabel: string;
  onConfirm: (draft: OptimizedDraft) => Promise<void>;
}) {
  const [pending, setPending] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<OptimizedDraft | null>(null);

  useEffect(() => {
    if (!open) return;
    setPending(true);
    setApplying(false);
    setError(null);
    setDraft(null);
    let cancelled = false;
    optimizeIdea(idea)
      .then((result) => {
        if (!cancelled) setDraft(result.draft);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Optimize failed.");
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per open, keyed on idea.id below
  }, [open, idea.id]);

  async function handleConfirm() {
    if (!draft) return;
    setApplying(true);
    setError(null);
    try {
      await onConfirm(draft);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Applying the optimized draft failed.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="optimize-modal">
        <DialogHeader>
          <DialogTitle>Optimize with AI</DialogTitle>
          <DialogDescription>
            Reviewed before anything is saved. {confirmLabel} to keep it, or cancel to discard.
          </DialogDescription>
        </DialogHeader>
        {pending && (
          <div className="flex items-center gap-2 text-sm text-text-secondary" data-testid="optimize-pending">
            <Spinner /> Optimizing...
          </div>
        )}
        {draft && (
          <div className="flex flex-col gap-3" data-testid="optimize-draft-preview">
            <div>
              <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">Title</p>
              <p className="text-sm text-text" data-testid="optimize-draft-title">
                {draft.title}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">Problem</p>
              <p className="text-sm whitespace-pre-wrap text-text" data-testid="optimize-draft-problem">
                {draft.problem}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">Outcome</p>
              <p className="text-sm whitespace-pre-wrap text-text" data-testid="optimize-draft-outcome">
                {draft.outcome}
              </p>
            </div>
            {draft.notes && (
              <div>
                <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">Notes</p>
                <p className="text-sm whitespace-pre-wrap text-text" data-testid="optimize-draft-notes">
                  {draft.notes}
                </p>
              </div>
            )}
            <Badge variant="secondary" className="w-fit" data-testid="optimize-draft-confidence">
              Confidence: {draft.confidence}
            </Badge>
          </div>
        )}
        {error && <InlineError message={error} data-testid="optimize-error" />}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={applying} />}>Cancel</DialogClose>
          <Button onClick={handleConfirm} disabled={pending || applying || !draft} data-testid="optimize-confirm-button">
            {applying && <Spinner />} {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubmittedView({ idea }: { idea: Idea }) {
  const navigate = useNavigate();
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [derivativeError, setDerivativeError] = useState<string | null>(null);

  async function handleCreateDerivative(draft: OptimizedDraft) {
    setDerivativeError(null);
    try {
      const created = await createDraft({
        title: draft.title,
        problem: draft.problem,
        outcome: draft.outcome,
        notes: draft.notes,
        confidence: draft.confidence,
        parentIdeaId: idea.id,
      });
      navigate(`/ideas/${created.id}`);
    } catch (err) {
      setDerivativeError(err instanceof Error ? err.message : "Creating the derivative failed.");
      throw err;
    }
  }

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
      {derivativeError && <InlineError message={derivativeError} data-testid="optimize-derivative-error" />}
      <Button variant="outline" onClick={() => setOptimizeOpen(true)} data-testid="optimize-derivative-button" className="w-fit">
        Optimize as new derivative
      </Button>
      <OptimizeModal
        idea={idea}
        open={optimizeOpen}
        onOpenChange={setOptimizeOpen}
        confirmLabel="Create derivative"
        onConfirm={handleCreateDerivative}
      />
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
  const [optimizeOpen, setOptimizeOpen] = useState(false);

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

  /** 05-h section 5's "apply in place (ordinary field UPDATE, guard-
   * permitted)": an immediate real UPDATE on confirm, not just a form-fill
   * for a later manual Save -- symmetric with SubmittedView's derivative
   * path, which also writes on confirm. Only reachable for mode === "edit"
   * (the Optimize button is hidden entirely in create mode: there is no
   * idea row yet to optimize or to log an intake.optimization row against). */
  async function handleApplyOptimized(draft: OptimizedDraft) {
    try {
      const updated = await updateIdea(ideaId, {
        title: draft.title,
        problem: draft.problem,
        outcome: draft.outcome,
        notes: draft.notes,
        confidence: draft.confidence,
      });
      setIdea(updated);
      setForm(toFormState(updated));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Applying the optimized draft failed.");
      throw err;
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
        {mode === "edit" && idea && (
          <Button variant="ghost" onClick={() => setOptimizeOpen(true)} disabled={saving} data-testid="optimize-idea-button">
            Optimize
          </Button>
        )}
        <Button variant="ghost" render={<Link to="/ideas" />} className="ml-auto">
          Back to list
        </Button>
      </div>

      {mode === "edit" && idea && (
        <OptimizeModal
          idea={idea}
          open={optimizeOpen}
          onOpenChange={setOptimizeOpen}
          confirmLabel="Apply"
          onConfirm={handleApplyOptimized}
        />
      )}

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
