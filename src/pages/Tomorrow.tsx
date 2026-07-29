// The Tomorrow Cockpit: today's assembled briefing, resolved for reading.
//
// A briefing stores only entity IDs — no titles, no times, no names (ADR 014):
// copied text would outlive the entity it was copied from, survive forget(),
// and stay full-text searchable. So the display data lives only in the cited
// entities, and this page resolves every id at read time through /entities/{id}.
// A briefing is a pointer: an id that no longer resolves is shown as gone
// rather than guessed at. Read-only — this page writes nothing.
import { useQueries, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { getEntity, searchEntities, type EntityView } from "../api/client";

type Attributes = Record<string, unknown>;
type Resolved = { id: string; entity?: EntityView["entity"]; missing: boolean };

const asString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const asIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** Today as a local date, the same shape as the briefing's `briefing_key`. */
function todayKey(now = new Date()): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function timeLabel(attributes: Attributes): string {
  if (attributes.all_day === true) return "All day";
  const startsAt = asString(attributes.starts_at);
  const at = startsAt ? new Date(startsAt) : undefined;
  if (!at || Number.isNaN(at.getTime())) return "Time unknown";
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const REASONS: Record<string, string> = {
  ambiguous_email_match: "More than one person matches this attendee.",
  conflicting_existing_link: "This attendee is already linked to someone else.",
};

/** A cited id is the only handle the briefing gives us; short form stays readable. */
function EntityLink({ id, label }: { id: string; label?: string }) {
  return (
    <Link to={`/entities/${id}`} className="mr-2 text-blue-700 hover:underline">
      {label ?? id.slice(0, 8)}
    </Link>
  );
}

function Gone({ id, noun }: { id: string; noun: string }) {
  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-3 text-sm text-zinc-500">
      This {noun} ({id.slice(0, 8)}) is no longer available.
    </li>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="text-sm text-zinc-500">{children}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-sm font-semibold uppercase text-zinc-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function Tomorrow() {
  const day = todayKey();
  const briefings = useQuery({
    queryKey: ["briefing", day],
    queryFn: () =>
      searchEntities({ type_name: "briefing", filters: { briefing_key: day } }),
  });

  const attributes: Attributes | undefined = briefings.data?.[0]?.attributes;
  const appointmentIds = asIds(attributes?.appointment_ids);
  const reviewIds = asIds(attributes?.open_review_ids);
  const checkinId = asString(attributes?.latest_checkin_id);
  const citedIds = [
    ...appointmentIds,
    ...reviewIds,
    ...(checkinId ? [checkinId] : []),
  ];

  const results = useQueries({
    queries: citedIds.map((id) => ({
      queryKey: ["entity", id],
      queryFn: () => getEntity(id),
    })),
  });
  const resolved = new Map<string, Resolved>(
    citedIds.map((id, index) => [
      id,
      {
        id,
        entity: results[index]?.data?.entity,
        missing: Boolean(results[index]?.isError),
      },
    ]),
  );
  const resolve = (id: string): Resolved =>
    resolved.get(id) ?? { id, missing: false };

  const appointments = appointmentIds
    .map(resolve)
    .sort((a, b) =>
      (asString(a.entity?.attributes.starts_at) ?? "").localeCompare(
        asString(b.entity?.attributes.starts_at) ?? "",
      ),
    );
  const checkin = checkinId ? resolve(checkinId) : undefined;

  if (briefings.isPending)
    return <p className="text-sm text-zinc-500">Loading…</p>;
  if (briefings.isError)
    return <p className="text-sm text-red-600">{String(briefings.error)}</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Tomorrow Cockpit</h1>
        <p className="text-sm text-zinc-500">
          {attributes
            ? `Briefing for ${asString(attributes.date) ?? day}`
            : `Nothing assembled for ${day}`}
        </p>
      </div>

      {!attributes ? (
        <Empty>
          No briefing for today yet — the daily job assembles one once it runs.
        </Empty>
      ) : (
        <>
          <Section title="Appointments">
            {appointments.length === 0 ? (
              <Empty>No appointments today.</Empty>
            ) : (
              <ul className="space-y-2">
                {appointments.map(({ id, entity, missing }) =>
                  missing || !entity ? (
                    <Gone key={id} id={id} noun="appointment" />
                  ) : (
                    <li key={id}>
                      <Link
                        to={`/entities/${id}`}
                        className="flex gap-3 rounded-lg border border-zinc-200 bg-white p-3 hover:border-zinc-400"
                      >
                        <span className="w-24 shrink-0 text-sm tabular-nums text-zinc-500">
                          {timeLabel(entity.attributes)}
                        </span>
                        <span className="text-sm">
                          <span className="font-medium">
                            {entity.name ??
                              asString(entity.attributes.title) ??
                              id.slice(0, 8)}
                          </span>
                          {asString(entity.attributes.location) && (
                            <span className="mt-0.5 block text-xs text-zinc-500">
                              {asString(entity.attributes.location)}
                            </span>
                          )}
                        </span>
                      </Link>
                    </li>
                  ),
                )}
              </ul>
            )}
          </Section>

          <Section title="Needs your decision">
            {reviewIds.length === 0 ? (
              <Empty>Nothing is waiting on you.</Empty>
            ) : (
              <ul className="space-y-2">
                {reviewIds.map(resolve).map(({ id, entity, missing }) =>
                  missing || !entity ? (
                    <Gone key={id} id={id} noun="review item" />
                  ) : (
                    <li
                      key={id}
                      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm"
                    >
                      <p>
                        {REASONS[asString(entity.attributes.reason) ?? ""] ??
                          "This link needs a human decision."}
                      </p>
                      <p className="mt-1 text-xs text-zinc-600">
                        Attendee:{" "}
                        {asString(entity.attributes.attendee_id) ? (
                          <EntityLink
                            id={asString(entity.attributes.attendee_id) ?? ""}
                          />
                        ) : (
                          "unknown"
                        )}
                        {asIds(entity.attributes.candidate_person_ids).length >
                          0 && (
                          <>
                            · Candidates:{" "}
                            {asIds(entity.attributes.candidate_person_ids).map(
                              (personId) => (
                                <EntityLink key={personId} id={personId} />
                              ),
                            )}
                          </>
                        )}
                        <EntityLink id={id} label="review item" />
                      </p>
                    </li>
                  ),
                )}
              </ul>
            )}
          </Section>

          <Section title="Latest check-in">
            {!checkin ? (
              <Empty>No check-in recorded yet.</Empty>
            ) : checkin.missing || !checkin.entity ? (
              <ul>
                <Gone id={checkin.id} noun="check-in" />
              </ul>
            ) : (
              <Link
                to={`/entities/${checkin.id}`}
                className="block rounded-lg border border-zinc-200 bg-white p-3 text-sm hover:border-zinc-400"
              >
                <span className="font-medium">
                  {asString(checkin.entity.attributes.date) ?? "Check-in"}
                </span>
                <span className="mt-1 block text-zinc-600">
                  {(["mood", "energy", "stress", "sleep_quality"] as const)
                    .filter((key) => checkin.entity?.attributes[key] != null)
                    .map(
                      (key) =>
                        `${key.replace("_", " ")} ${String(checkin.entity?.attributes[key])}/5`,
                    )
                    .join(" · ")}
                </span>
                {asIds(checkin.entity.attributes.top_priorities).length > 0 && (
                  <span className="mt-1 block text-zinc-600">
                    Priorities:{" "}
                    {asIds(checkin.entity.attributes.top_priorities).join(", ")}
                  </span>
                )}
                {asString(checkin.entity.attributes.note) && (
                  <span className="mt-1 block text-zinc-500">
                    {asString(checkin.entity.attributes.note)}
                  </span>
                )}
              </Link>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
