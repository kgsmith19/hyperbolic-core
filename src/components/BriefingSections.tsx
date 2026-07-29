// The three section bodies of the Tomorrow cockpit (page: pages/Tomorrow.tsx).
//
// Each one renders ids the briefing cited and the page already resolved
// (ADR 014): an id that no longer resolves is shown as gone, never guessed at.
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { EntityView } from "../api/client";
import { asIds, asString, type Attributes } from "../attributes";

export type Resolved = {
  id: string;
  entity?: EntityView["entity"];
  missing: boolean;
};

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

export function Empty({ children }: { children: string }) {
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

export function Appointments({ items }: { items: Resolved[] }) {
  const byStart = [...items].sort((a, b) =>
    (asString(a.entity?.attributes.starts_at) ?? "").localeCompare(
      asString(b.entity?.attributes.starts_at) ?? "",
    ),
  );
  return (
    <Section title="Appointments">
      {byStart.length === 0 ? (
        <Empty>No appointments today.</Empty>
      ) : (
        <ul className="space-y-2">
          {byStart.map(({ id, entity, missing }) =>
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
  );
}

export function OpenReviews({ items }: { items: Resolved[] }) {
  return (
    <Section title="Needs your decision">
      {items.length === 0 ? (
        <Empty>Nothing is waiting on you.</Empty>
      ) : (
        <ul className="space-y-2">
          {items.map(({ id, entity, missing }) =>
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
                  {asIds(entity.attributes.candidate_person_ids).length > 0 && (
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
  );
}

export function LatestCheckin({ item }: { item?: Resolved }) {
  return (
    <Section title="Latest check-in">
      {!item ? (
        <Empty>No check-in recorded yet.</Empty>
      ) : item.missing || !item.entity ? (
        <ul>
          <Gone id={item.id} noun="check-in" />
        </ul>
      ) : (
        <Link
          to={`/entities/${item.id}`}
          className="block rounded-lg border border-zinc-200 bg-white p-3 text-sm hover:border-zinc-400"
        >
          <span className="font-medium">
            {asString(item.entity.attributes.date) ?? "Check-in"}
          </span>
          <span className="mt-1 block text-zinc-600">
            {(["mood", "energy", "stress", "sleep_quality"] as const)
              .filter((key) => item.entity?.attributes[key] != null)
              .map(
                (key) =>
                  `${key.replace("_", " ")} ${String(item.entity?.attributes[key])}/5`,
              )
              .join(" · ")}
          </span>
          {asIds(item.entity.attributes.top_priorities).length > 0 && (
            <span className="mt-1 block text-zinc-600">
              Priorities:{" "}
              {asIds(item.entity.attributes.top_priorities).join(", ")}
            </span>
          )}
          {asString(item.entity.attributes.note) && (
            <span className="mt-1 block text-zinc-500">
              {asString(item.entity.attributes.note)}
            </span>
          )}
        </Link>
      )}
    </Section>
  );
}
