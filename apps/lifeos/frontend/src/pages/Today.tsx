// The Today command center (#531, first slice): at most three actionable
// one-offs, the recurring anchors kept apart, the next two-minute action,
// and an explicit progress state per item. Every status change is one
// appended event on the backend (domains/intentions/today.py); this page
// never edits history, it only refetches after a change. A stale item
// (untouched for 14 days) says so instead of looking current.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getToday,
  PROGRESS,
  setIntentionProgress,
  type Progress,
  type TodayItem,
} from "../api/client";
import { Empty } from "../components/BriefingSections";
import { ErrorText, Loading } from "../components/QueryStatus";

function Item({
  item,
  onProgress,
  busy,
}: {
  item: TodayItem;
  onProgress: (id: string, progress: Progress) => void;
  busy: boolean;
}) {
  return (
    <li className="rounded border border-zinc-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.title}</span>
        {item.focus && <span className="text-xs text-amber-600">focus</span>}
        {item.stale && (
          <span className="text-xs text-red-600">stale: not updated in 14+ days</span>
        )}
      </div>
      {item.next_action && (
        <p className="mt-1 text-sm text-zinc-600">Next: {item.next_action}</p>
      )}
      {item.floor && (
        <p className="text-sm text-zinc-500">Floor: {item.floor}</p>
      )}
      <div
        className="mt-2 flex flex-wrap gap-1"
        role="group"
        aria-label={`Progress for ${item.title}`}
      >
        {PROGRESS.map((progress) => (
          <button
            key={progress}
            type="button"
            aria-pressed={item.progress === progress}
            disabled={busy || item.progress === progress}
            onClick={() => onProgress(item.intention_id, progress)}
            className={`min-h-9 rounded border px-2 text-xs ${
              item.progress === progress
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-300"
            } disabled:opacity-60`}
          >
            {progress}
          </button>
        ))}
      </div>
    </li>
  );
}

export default function Today() {
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ["intentions", "today"], queryFn: getToday });
  const change = useMutation({
    mutationFn: ({ id, progress }: { id: string; progress: Progress }) =>
      setIntentionProgress(id, progress),
    // Refetch this view, and the Tomorrow plan, which shows the same intentions.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["intentions", "today"] });
      void queryClient.invalidateQueries({ queryKey: ["intentions", "plan"] });
    },
  });

  if (view.isPending) return <Loading />;
  if (view.isError) return <ErrorText error={view.error} />;

  const { one_offs, more_one_offs, anchors, next_two_minute_action, as_of } =
    view.data;
  const onProgress = (id: string, progress: Progress) =>
    change.mutate({ id, progress });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Today</h1>
        <p className="text-sm text-zinc-500">
          As of {new Date(as_of).toLocaleString()}
        </p>
      </div>

      <section aria-labelledby="next-action">
        <h2 id="next-action" className="text-lg font-medium">
          Next two-minute action
        </h2>
        {next_two_minute_action ? (
          <p className="mt-1">{next_two_minute_action}</p>
        ) : (
          <Empty>No next action recorded.</Empty>
        )}
      </section>

      <section aria-labelledby="priorities">
        <h2 id="priorities" className="text-lg font-medium">
          Top priorities
        </h2>
        {one_offs.length === 0 ? (
          <Empty>No open one-off priorities.</Empty>
        ) : (
          <ul className="mt-2 space-y-2">
            {one_offs.map((item) => (
              <Item
                key={item.intention_id}
                item={item}
                onProgress={onProgress}
                busy={change.isPending}
              />
            ))}
          </ul>
        )}
        {more_one_offs > 0 && (
          <p className="mt-2 text-sm text-zinc-500">
            {more_one_offs} more open, see the Tomorrow plan.
          </p>
        )}
      </section>

      <section aria-labelledby="anchors">
        <h2 id="anchors" className="text-lg font-medium">
          Daily anchors
        </h2>
        {anchors.length === 0 ? (
          <Empty>No recurring anchors.</Empty>
        ) : (
          <ul className="mt-2 space-y-2">
            {anchors.map((item) => (
              <Item
                key={item.intention_id}
                item={item}
                onProgress={onProgress}
                busy={change.isPending}
              />
            ))}
          </ul>
        )}
      </section>

      {change.error && (
        <p role="alert" className="text-sm text-red-600">
          Could not save the change: {String(change.error)}
        </p>
      )}
    </div>
  );
}
