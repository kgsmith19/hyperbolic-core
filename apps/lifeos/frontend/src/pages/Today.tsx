// The Today command center (#531): at most three actionable one-offs, the
// recurring anchors kept apart, the next two-minute action, and an explicit
// progress state per item. Slice 2 adds the day's context: the
// God/Family/Work balance, today's schedule, the next commitments, and the
// health of every source, so a stale calendar is said out loud. Every status change is one
// appended event on the backend (domains/intentions/today.py); this page
// never edits history, it only refetches after a change. A stale item
// (untouched for 14 days) says so instead of looking current.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  AREAS,
  getToday,
  PROGRESS,
  setIntentionProgress,
  type Appointment,
  type Progress,
  type SourceHealth,
  type TodayItem,
  type TodayView,
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
    <li className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.title}</span>
        {item.focus && <span className="text-xs text-amber-600">focus</span>}
        {item.stale && (
          <span className="text-xs text-red-600">
            stale: not updated in 14+ days
          </span>
        )}
      </div>
      {item.next_action && (
        <p className="mt-1 text-sm text-zinc-600">Next: {item.next_action}</p>
      )}
      {item.floor && (
        <p className="text-sm text-zinc-500">Floor: {item.floor}</p>
      )}
      <div
        className="mt-3 flex flex-wrap gap-1"
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

const AREA_LABELS = { god: "God", family: "Family", work: "Work" } as const;

function Balance({ balance }: { balance: TodayView["balance"] }) {
  return (
    <section aria-labelledby="balance">
      <h2 id="balance" className="text-lg font-medium">
        Balance
      </h2>
      <ul className="mt-1 flex flex-wrap gap-2 text-sm">
        {AREAS.map((area) => (
          <li
            key={area}
            className={`rounded border px-2 py-1 ${
              balance[area] === 0
                ? "border-amber-400 text-amber-700"
                : "border-zinc-200"
            }`}
          >
            {AREA_LABELS[area]}: {balance[area]}
            {balance[area] === 0 && (
              <span className="sr-only"> (nothing open)</span>
            )}
          </li>
        ))}
        {balance.unassigned > 0 && (
          <li className="rounded border border-zinc-200 px-2 py-1 text-zinc-500">
            Unassigned: {balance.unassigned}
          </li>
        )}
      </ul>
    </section>
  );
}

function when(appointment: Appointment, withDay: boolean): string {
  const date = new Date(appointment.starts_at);
  const day = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (appointment.all_day) return withDay ? `${day}, all day` : "All day";
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return withDay ? `${day}, ${time}` : time;
}

function Appointments({
  id,
  heading,
  items,
  withDay,
  more,
  unavailable,
  empty,
}: {
  id: string;
  heading: string;
  items: Appointment[];
  withDay: boolean;
  more: number;
  unavailable: boolean;
  empty: string;
}) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-lg font-medium">
        {heading}
      </h2>
      {unavailable ? (
        <p className="text-sm text-red-600">
          Calendar not available to this session.
        </p>
      ) : items.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="mt-2 space-y-1">
          {items.map((appointment) => (
            <li
              key={appointment.appointment_id}
              className="flex flex-wrap gap-2 text-sm"
            >
              <span className="min-w-24 text-zinc-500">
                {when(appointment, withDay)}
              </span>
              <span>{appointment.title ?? "(title erased)"}</span>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && (
        <p className="mt-1 text-sm text-zinc-500">{more} more this week.</p>
      )}
    </section>
  );
}

const JOB_LABELS: Record<string, string> = {
  "domains.ops.briefing": "Morning briefing",
  "domains.calendar.ingest": "Calendar sync",
  "domains.calendar.autolink": "Calendar people links",
};

function Sources({
  sources,
  unavailable,
}: {
  sources: SourceHealth[];
  unavailable: boolean;
}) {
  return (
    <section aria-labelledby="sources">
      <h2 id="sources" className="text-lg font-medium">
        Sources
      </h2>
      {unavailable ? (
        <p className="text-sm text-red-600">
          Source status not available to this session.
        </p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {sources.map((source) => {
            const failed =
              source.last_status !== null && source.last_status !== "ok";
            const state =
              source.last_receipt_at === null
                ? "never run"
                : failed
                  ? `last run ${source.last_status}`
                  : source.missed
                    ? "not run today"
                    : "up to date";
            return (
              <li key={source.job} className="flex flex-wrap gap-2">
                <span>{JOB_LABELS[source.job] ?? source.job}</span>
                <span
                  className={
                    failed || source.missed ? "text-red-600" : "text-green-700"
                  }
                >
                  {state}
                </span>
                {source.last_receipt_at && (
                  <span className="text-zinc-500">
                    ({new Date(source.last_receipt_at).toLocaleString()})
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function Today() {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ["intentions", "today"],
    queryFn: getToday,
  });
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

  const {
    one_offs,
    more_one_offs,
    anchors,
    next_two_minute_action,
    as_of,
    balance,
    schedule,
    upcoming,
    more_upcoming,
    sources,
    unavailable,
  } = view.data;
  const calendarUnavailable = unavailable.includes("calendar");
  const onProgress = (id: string, progress: Progress) =>
    change.mutate({ id, progress });

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="text-sm text-zinc-500">
          As of {new Date(as_of).toLocaleString()}
        </p>
      </div>

      <section aria-labelledby="next-action" className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
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
        <h2 id="priorities" className="text-lg font-semibold">
          Top priorities <span className="ml-2 text-sm font-normal text-zinc-500">{one_offs.length} of 3</span>
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

      <section aria-labelledby="anchors" className="rounded-xl border border-zinc-200 p-4">
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

      <details className="rounded-xl border border-zinc-200 p-4">
        <summary className="cursor-pointer font-medium">Life balance</summary>
        <div className="mt-3"><Balance balance={balance} /></div>
      </details>

      <Appointments
        id="schedule"
        heading="Today's schedule"
        items={schedule}
        withDay={false}
        more={0}
        unavailable={calendarUnavailable}
        empty="Nothing on the calendar today."
      />

      <details className="rounded-xl border border-zinc-200 p-4">
        <summary className="cursor-pointer font-medium">Upcoming commitments</summary>
        <div className="mt-3"><Appointments
        id="upcoming"
        heading="Coming up"
        items={upcoming}
        withDay
        more={more_upcoming}
        unavailable={calendarUnavailable}
        empty="Nothing in the next week."
        /></div>
      </details>

      <details className="rounded-xl border border-zinc-200 p-4">
        <summary className="cursor-pointer font-medium">Source health and sync details</summary>
        <div className="mt-3"><Sources
          sources={sources}
          unavailable={unavailable.includes("sources")}
        /></div>
      </details>

      {change.error && (
        <p role="alert" className="text-sm text-red-600">
          Could not save the change: {String(change.error)}
        </p>
      )}
    </div>
  );
}
