// /tools route group: registry-driven tool discovery (m3-04,
// docs/planning/05-c-toolbelt.md section 4.3, TB-2). Renders exclusively
// from `useRegisteredTools()` -- there is no hardcoded tool list anywhere in
// this file, by construction: the map over `navTools`/`statusTools` below is
// the ENTIRE catalog surface, so a newly registered tool appears here with
// zero further Shell code change (the exact property e2e/tools.spec.ts's
// scripted TB-2 check proves).
import { Link } from "react-router";
import { LayoutGrid, Wrench } from "lucide-react";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  useDelayedVisible,
} from "@hyperbolic/ui";
import { splitByRoute, useRegisteredTools } from "../lib/registry";

function ToolsPageSkeleton() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6" data-testid="tools-page-skeleton">
      <Skeleton className="h-7 w-32" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}

function ToolsPage() {
  const { status, tools, errorMessage, retry } = useRegisteredTools();
  const showSkeleton = useDelayedVisible(status === "loading");

  if (status === "error") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState
          title="Could not load the tool registry"
          message={errorMessage ?? undefined}
          onRetry={retry}
        />
      </div>
    );
  }

  if (status === "loading") {
    return showSkeleton ? <ToolsPageSkeleton /> : null;
  }

  const { navTools, statusTools } = splitByRoute(tools);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6" data-testid="tools-page">
      <div>
        <h2 className="text-xl font-semibold text-text">Tools</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Live from the Toolbelt registry (core.app) -- nothing on this page is hardcoded.
        </p>
      </div>

      <section>
        <h3 className="mb-3 text-xs font-semibold tracking-wide text-text-secondary uppercase">Open</h3>
        {navTools.length === 0 ? (
          <EmptyState icon={<Wrench />} title="No navigable tools registered yet." />
        ) : (
          <div data-testid="tools-nav-list" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {navTools.map((tool) => (
              <Link
                key={tool.id}
                to={tool.route as string}
                data-testid="tool-nav-entry"
                data-tool-id={tool.id}
                className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Card className="h-full transition-colors hover:bg-accent-muted">
                  <CardHeader className="flex flex-row items-center justify-between gap-2">
                    <CardTitle>{tool.name}</CardTitle>
                    <Badge variant="secondary">{tool.status}</Badge>
                  </CardHeader>
                  <CardContent className="text-sm text-text-secondary">
                    {tool.description ?? tool.route}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-xs font-semibold tracking-wide text-text-secondary uppercase">Status</h3>
        {statusTools.length === 0 ? (
          <EmptyState icon={<LayoutGrid />} title="No headless tools registered yet." />
        ) : (
          <div
            data-testid="tools-status-list"
            className="flex flex-col divide-y divide-border rounded-xl ring-1 ring-text/10"
          >
            {statusTools.map((tool) => (
              <div
                key={tool.id}
                data-testid="tool-status-entry"
                data-tool-id={tool.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-text">{tool.name}</p>
                  {tool.description && <p className="text-xs text-text-secondary">{tool.description}</p>}
                </div>
                <Badge variant="secondary">
                  {tool.kind} &middot; {tool.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default ToolsPage;
