// The weekly review / briefing surface (05-e-lifeos.md section 2 candidate
// a, selected; LO-3; m5-07): the daily briefing narrative and every
// scheduled job's execution_receipt trail already exist (ADR 014) — this
// page is a read surface over both for an operator-chosen date range, plus
// a job-health panel that flags a scheduled job with no receipt for its
// most recent expected slot. Read-only, like every other page in this
// zone that doesn't have its own decide action — nothing here writes
// anything.
import { Button, Input } from "@hyperbolic/ui";
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
  if (status === "ok") return "text-success";
  if (status === "failed") return "text-danger";
  return "text-warn";
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
        <p className="text-sm text-text-muted">
          Briefings, scheduled-job receipts, and job health for a date range.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-sm text-text-secondary">
          Start
          <Input type="date" name="start" defaultValue={range.start} />
        </label>
        <label className="flex flex-col text-sm text-text-secondary">
          End
          <Input type="date" name="end" defaultValue={range.end} />
        </label>
        <Button type="submit">Apply</Button>
      </form>

      {feed.isPending ? (
        <Loading />
      ) : feed.isError ? (
        <ErrorText error={feed.error} />
      ) : (
        <>
          <section>
            <h2 className="text-sm font-medium text-text-secondary">
              Job health
            </h2>
            <ul className="mt-2 space-y-1">
              {feed.data.job_health.map((h) => (
                <li
                  key={h.job}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span className="font-mono text-text-secondary">{h.job}</span>
                  {h.missed ? (
                    <span className="text-danger">missed today</span>
                  ) : (
                    <span className={statusColor(h.last_status ?? "")}>
                      last run {h.last_status ?? "unknown"}
                    </span>
                  )}
                  {h.last_receipt_at && (
                    <span className="text-text-muted">{h.last_receipt_at}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-sm font-medium text-text-secondary">
              Briefings
            </h2>
            {feed.data.briefings.length === 0 ? (
              <Empty>No briefings in this range.</Empty>
            ) : (
              <ul className="mt-2 space-y-1">
                {feed.data.briefings.map((b) => (
                  <li key={b.briefing_id} className="text-sm">
                    <Link
                      to={`/entities/${b.briefing_id}`}
                      className="text-info hover:underline"
                    >
                      {b.date}
                    </Link>
                    <span className="ml-2 text-text-muted">
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
            <h2 className="text-sm font-medium text-text-secondary">
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
                    <span className="font-mono text-text-secondary">
                      {r.job}
                    </span>
                    <span className={statusColor(r.status)}>{r.status}</span>
                    <span className="text-text-muted">{r.started_at}</span>
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
