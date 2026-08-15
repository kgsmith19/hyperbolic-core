// /ideas list (05-h section 8): "One table: title, status chip
// (draft/idea/submitted), confidence, target repo, updated. Filter tabs:
// All, Drafts, Ideas, Submitted. Primary action 'New idea'. Submitted rows
// show the issue number as an outbound GitHub link and render visually
// locked. Derivative rows show a 'derived from #n' affordance linking the
// parent." One query (risk note: "one-query list"); filter tabs and the
// title filter are both client-side narrowing over that one fetch, per the
// section's own simplicity rule.
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ExternalLink, Lightbulb, Plus } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  Tabs,
  TabsList,
  TabsTab,
  useDelayedVisible,
} from "@hyperbolic/ui";
import { listIdeas, type Idea, type IdeaStatus } from "../../lib/intake";
import { useAsync } from "../../lib/use-async";

type FilterTab = "all" | "draft" | "idea" | "submitted_to_github";

const TAB_LABEL: Record<FilterTab, string> = {
  all: "All",
  draft: "Drafts",
  idea: "Ideas",
  submitted_to_github: "Submitted",
};

const STATUS_LABEL: Record<IdeaStatus, string> = {
  draft: "Draft",
  idea: "Idea",
  submitted_to_github: "Submitted",
};

const STATUS_BADGE_VARIANT: Record<IdeaStatus, "secondary" | "default"> = {
  draft: "secondary",
  idea: "default",
  submitted_to_github: "secondary",
};

function matchesTab(idea: Idea, tab: FilterTab): boolean {
  return tab === "all" || idea.status === tab;
}

function ListSkeleton() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6" data-testid="ideas-list-skeleton">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-9 w-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  );
}

function IdeaRow({ idea }: { idea: Idea }) {
  const locked = idea.status === "submitted_to_github";
  return (
    <div
      data-testid="idea-row"
      data-idea-id={idea.id}
      data-status={idea.status}
      className="flex items-center justify-between gap-3 px-4 py-3"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          {locked ? (
            <span className="truncate text-sm font-medium text-text" data-testid="idea-title">
              {idea.title}
            </span>
          ) : (
            <Link
              to={`/ideas/${idea.id}`}
              data-testid="idea-title-link"
              className="truncate text-sm font-medium text-text underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {idea.title}
            </Link>
          )}
          <Badge variant={STATUS_BADGE_VARIANT[idea.status]}>{STATUS_LABEL[idea.status]}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
          <span data-testid="idea-confidence">Confidence: {idea.confidence}</span>
          {idea.targetRepo && <span data-testid="idea-target-repo">{idea.targetRepo}</span>}
          <span data-testid="idea-updated">Updated {new Date(idea.updatedAt).toLocaleString()}</span>
          {idea.parentGithubIssueUrl && (
            <a
              href={idea.parentGithubIssueUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="idea-derived-from"
              className="inline-flex items-center gap-1 text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              derived from <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      </div>
      {locked && idea.githubIssueUrl && (
        <a
          href={idea.githubIssueUrl}
          target="_blank"
          rel="noreferrer"
          data-testid="idea-issue-link"
          className="inline-flex shrink-0 items-center gap-1 text-sm text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          #{idea.githubIssueNumber} <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}

function IdeasListPage() {
  const { status, data, errorMessage, retry } = useAsync(listIdeas);
  const showSkeleton = useDelayedVisible(status === "loading");
  const [tab, setTab] = useState<FilterTab>("all");
  const [titleFilter, setTitleFilter] = useState("");

  const filtered = useMemo(() => {
    const ideas = data ?? [];
    const needle = titleFilter.trim().toLowerCase();
    return ideas
      .filter((idea) => matchesTab(idea, tab))
      .filter((idea) => !needle || idea.title.toLowerCase().includes(needle));
  }, [data, tab, titleFilter]);

  if (status === "error") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState title="Could not load ideas" message={errorMessage ?? undefined} onRetry={retry} />
      </div>
    );
  }

  if (status === "loading") {
    return showSkeleton ? <ListSkeleton /> : null;
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6" data-testid="ideas-list-page">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-text">Ideas</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Capture, promote, and submit ideas as GitHub Issues.
          </p>
        </div>
        <Button render={<Link to="/ideas/new" data-testid="new-idea-button" />} size="sm">
          <Plus /> New idea
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(value) => setTab(value as FilterTab)}>
          <TabsList data-testid="ideas-filter-tabs">
            {(Object.keys(TAB_LABEL) as FilterTab[]).map((key) => (
              <TabsTab key={key} value={key} data-testid={`ideas-tab-${key}`}>
                {TAB_LABEL[key]}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
        <Input
          type="search"
          placeholder="Filter by title"
          value={titleFilter}
          onChange={(event) => setTitleFilter(event.target.value)}
          data-testid="ideas-title-filter"
          className="sm:max-w-xs"
          aria-label="Filter ideas by title"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Lightbulb />}
          title={(data ?? []).length === 0 ? "No ideas captured yet." : "No ideas match this filter."}
          action={
            (data ?? []).length === 0 ? (
              <Button render={<Link to="/ideas/new" />} size="sm" variant="outline">
                Capture your first idea
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div
          data-testid="ideas-rows"
          className="flex flex-col divide-y divide-border rounded-xl ring-1 ring-text/10"
        >
          {filtered.map((idea) => (
            <IdeaRow key={idea.id} idea={idea} />
          ))}
        </div>
      )}
    </div>
  );
}

export default IdeasListPage;
