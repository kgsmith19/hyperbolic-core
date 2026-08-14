// The Brain run/chat surface (m4-16, docs/planning/issues/m4-16-feat-shell-
// brain-surface.md; anatomy per docs/planning/09-design-system.md section
// 7.1). Mounted at /acc/brain (apps/shell/src/pages/acc.tsx).
//
// Real API-shape constraint, stated once here: services/brain's HTTP API
// (m4-14) has no "list all runs" route -- only POST /runs (create) and GET
// /runs/{id} (one specific run). So this page cannot browse run history;
// it starts a new run or resumes a specific one via the `?run=` query
// param (which is exactly what BR-4's reconnect-with-no-lost-state
// requirement needs: the param survives a reload, and useBrainRunStream
// replays the journal + re-polls run/task state from there).
import * as React from "react";
import { useSearchParams } from "react-router";
import {
  StatusStrip,
  CostTicker,
  Transcript,
  Composer,
  Badge,
  Input,
  Label,
  EmptyState,
} from "@hyperbolic/ui";
import { Rocket } from "lucide-react";
import { brainClient } from "../../lib/session";
import { useBrainRunStream } from "../../lib/use-brain-run-stream";

const DEFAULT_REPO_URL = "https://github.com/kgsmith19/hyperbolic-core";
const DEFAULT_REPO_REF = "main";

function isTextInputTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs)) return "";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** New-run form: objective + repo url/ref, shown while no run is selected. */
function StartRunForm({ onCreated }: { onCreated: (runId: string) => void }) {
  const [objective, setObjective] = React.useState("");
  const [repoUrl, setRepoUrl] = React.useState(DEFAULT_REPO_URL);
  const [repoRef, setRepoRef] = React.useState(DEFAULT_REPO_REF);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (!objective.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await brainClient.createRun({
        objective: objective.trim(),
        repo: { url: repoUrl.trim(), ref: repoRef.trim() },
      });
      onCreated(result.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the run.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-6" data-testid="brain-start-run-form">
      <div>
        <h2 className="text-xl font-semibold text-text">Start a Brain run</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Describe what the Brain should do. It plans, dispatches, and streams progress here.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="brain-repo-url">Repo</Label>
        <Input id="brain-repo-url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="brain-repo-ref">Branch</Label>
        <Input id="brain-repo-ref" value={repoRef} onChange={(e) => setRepoRef(e.target.value)} />
      </div>
      <Composer
        value={objective}
        onChange={setObjective}
        onSend={submit}
        running={submitting}
        placeholder="What should the Brain do?"
        className="border-none bg-transparent p-0"
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

interface RunTreePanelProps {
  objective: string | undefined;
  tasks: readonly { id: string; title: string; status: string; createdAt: string }[];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}

/** 09 section 7.1's run-tree/task panel, narrowed to one run's own task list (see this file's header comment on why there is no cross-run tree yet). Keyboard: j/k to move, Enter to select. */
function RunTreePanel({ objective, tasks, selectedTaskId, onSelect }: RunTreePanelProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (isTextInputTarget(event.target)) return;
    if (tasks.length === 0) return;
    const currentIndex = Math.max(0, tasks.findIndex((t) => t.id === selectedTaskId));
    if (event.key === "j") {
      event.preventDefault();
      onSelect(tasks[Math.min(tasks.length - 1, currentIndex + 1)]!.id);
    } else if (event.key === "k") {
      event.preventDefault();
      onSelect(tasks[Math.max(0, currentIndex - 1)]!.id);
    } else if (event.key === "Enter" && selectedTaskId === null) {
      event.preventDefault();
      onSelect(tasks[currentIndex]!.id);
    }
  }

  return (
    <div
      ref={containerRef}
      data-testid="brain-run-tree"
      role="tree"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-3 outline-none"
    >
      {objective && <p className="mb-2 text-xs font-medium text-text-secondary">{objective}</p>}
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          role="treeitem"
          aria-selected={task.id === selectedTaskId}
          onClick={() => onSelect(task.id)}
          data-testid="brain-task-node"
          className={`flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${
            task.id === selectedTaskId ? "bg-accent-muted text-text" : "text-text-secondary hover:bg-accent-muted/50"
          }`}
        >
          <span className="flex w-full items-center gap-1.5">
            <Badge variant="secondary">{task.status.replace(/_/g, " ")}</Badge>
            <span className="truncate">{task.title}</span>
          </span>
          <span className="font-mono text-xs text-text-muted">{relativeTime(task.createdAt)}</span>
        </button>
      ))}
    </div>
  );
}

function BrainRunSurface({ runId }: { runId: string }) {
  const { transcript, run, tasks, connectionState, reconnectAttempt, approve, reject } = useBrainRunStream(runId);
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null);
  const [composerValue, setComposerValue] = React.useState("");

  const runIsActive = run?.status === "running" || run?.status === "queued";
  const readOnlyReason = connectionState === "offline" ? "Reconnecting to the Brain — read-only until back online." : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StatusStrip
        connectionState={connectionState}
        reconnectAttempt={reconnectAttempt}
        runState={run?.status as never}
        costTicker={<CostTicker currentRunUsd={0} />}
      />
      <div className="flex min-h-0 flex-1">
        <RunTreePanel
          objective={run?.objective}
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onSelect={setSelectedTaskId}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          <Transcript
            items={transcript.items}
            onApprove={(itemId) => void approve(itemId.replace(/^approval-/, ""))}
            onReject={(itemId, reason) => void reject(itemId.replace(/^approval-/, ""), reason)}
          />
          <Composer
            value={composerValue}
            onChange={setComposerValue}
            onSend={() => setComposerValue("")}
            running={runIsActive}
            disabledReason={readOnlyReason}
            placeholder="Follow-up messages aren't wired to a running task yet (m4-16 gap, see the PR notes)"
          />
        </div>
      </div>
    </div>
  );
}

function BrainPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const runId = searchParams.get("run");

  function selectRun(id: string) {
    setSearchParams({ run: id });
  }

  if (!runId) {
    return (
      <div className="flex h-full flex-col">
        <StartRunForm onCreated={selectRun} />
        <EmptyState
          icon={<Rocket />}
          title="No run selected yet — start one above, or open a link from a Brain notification."
        />
      </div>
    );
  }

  return <BrainRunSurface key={runId} runId={runId} />;
}

export default BrainPage;
