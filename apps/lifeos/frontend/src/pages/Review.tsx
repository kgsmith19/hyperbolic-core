// The weekly review / briefing surface (05-e-lifeos.md section 2 candidate
// a, selected; LO-3; m5-07): the daily briefing narrative and every
// scheduled job's execution_receipt trail already exist (ADR 014) — this
// page is a read surface over both for an operator-chosen date range, plus
// a job-health panel that flags a scheduled job with no receipt for its
// most recent expected slot. Read-only, like every other page in this
// zone that doesn't have its own decide action — nothing here writes
// anything.
import { useQuery } from "@tanstack/react-query";
import { useState, type SubmitEvent } from "react";
import { Link } from "react-router";

import { getReviewFeed } from "../api/client";
import { Empty } from "../components/BriefingSections";
import { ErrorText, Loading } from "../components/QueryStatus";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Last 7 days ending today — the "weekly" in "weekly review", and a
// small enough default window that the page never opens to an empty or
// enormous first render.
function defaultRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { start: isoDate(start), end: isoDate(end) };
}

function statusColor(status: string): string {
  if (status === "ok") return "text-emerald-700";
  if (status === "failed") return "text-red-600";
  return "text-amber-600";
}

export default function Review() {
  const [range, setRange] = useState(defaultRange);
  const feed = useQuery({
    queryKey: ["review", range.start, range.end],
    queryFn: () => getReviewFeed(range.start, range.end),
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const start = String(form.get("start"));
    const end = String(form.get("end"));
    if (start && end) setRange({ start, end });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Review</h1>
        <p className="text-sm text-zinc-500">
          Briefings, scheduled-job receipts, and job health for a date
          range.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-sm text-zinc-600">
          Start
          <input
            type="date"
            name="start"
            defaultValue={range.start}
            className="rounded border border-zinc-300 px-2 py-1.5"
          />
        </label>
        <label className="flex flex-col text-sm text-zinc-600">
          End
          <input
            type="date"
            name="end"
            defaultValue={range.end}
            className="rounded border border-zinc-300 px-2 py-1.5"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white"
        >
          Apply
        </button>
      </form>

      {feed.isPending ? (
        <Loading />
      ) : feed.isError ? (
        <ErrorText error={feed.error} />
      ) : (
        <>
          <section>
            <h2 className="text-sm font-medium text-zinc-700">Job health</h2>
            <ul className="mt-2 space-y-1">
              {feed.data.job_health.map((h) => (
                <li
                  key={h.job}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span className="font-mono text-zinc-600">{h.job}</span>
                  {h.missed ? (
                    <span className="text-red-600">missed today</span>
                  ) : (
                    <span className={statusColor(h.last_status ?? "")}>
                      last run {h.last_status ?? "unknown"}
                    </span>
                  )}
                  {h.last_receipt_at && (
                    <span className="text-zinc-400">{h.last_receipt_at}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-sm font-medium text-zinc-700">Briefings</h2>
            {feed.data.briefings.length === 0 ? (
              <Empty>No briefings in this range.</Empty>
            ) : (
              <ul className="mt-2 space-y-1">
                {feed.data.briefings.map((b) => (
                  <li key={b.briefing_id} className="text-sm">
                    <Link
                      to={`/entities/${b.briefing_id}`}
                      className="text-blue-700 hover:underline"
                    >
                      {b.date}
                    </Link>
                    <span className="ml-2 text-zinc-500">
                      {b.focus_intention_ids.length} focus,{" "}
                      {b.appointment_ids.length} appointment
                      {b.appointment_ids.length === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-sm font-medium text-zinc-700">
              Execution receipts
            </h2>
            {feed.data.receipts.length === 0 ? (
              <Empty>No scheduled-job receipts in this range.</Empty>
            ) : (
              <ul className="mt-2 space-y-1">
                {feed.data.receipts.map((r) => (
                  <li
                    key={r.receipt_id}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span className="font-mono text-zinc-600">{r.job}</span>
                    <span className={statusColor(r.status)}>{r.status}</span>
                    <span className="text-zinc-400">{r.started_at}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
