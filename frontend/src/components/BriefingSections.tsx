// The section bodies of the Tomorrow cockpit (page: pages/Tomorrow.tsx).
//
// Each one renders ids the briefing cited and the page already resolved
// (ADR 014): an id that no longer resolves is shown as gone, never guessed at —
// and one still resolving is shown as loading, never as gone.
// INT1 composition order: focus intentions, then appointments, then nothing
// else; the Monday edition's gate is inline counts, so it resolves nothing.
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { EntityView } from "../api/client";
import { asString, type Attributes, type Gate } from "../attributes";

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

function displayName(entity: EntityView["entity"], id: string): string {
  return entity.name ?? asString(entity.attributes.title) ?? id.slice(0, 8);
}

function Gone({ id, noun }: { id: string; noun: string }) {
  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-3 text-sm text-zinc-500">
      This {noun} ({id.slice(0, 8)}) is no longer available.
    </li>
  );
}

function Pending() {
  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-3 text-sm text-zinc-400">
      Loading…
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

export function FocusIntentions({ items }: { items: Resolved[] }) {
  return (
    <Section title="Focus goals">
      {items.length === 0 ? (
        <Empty>
          No focus goals yet — mark up to three intentions as focus.
        </Empty>
      ) : (
        <ul className="space-y-2">
          {items.map(({ id, entity, missing }) =>
            missing ? (
              <Gone key={id} id={id} noun="intention" />
            ) : !entity ? (
              <Pending key={id} />
            ) : (
              <li key={id}>
                <Link
                  to={`/entities/${id}`}
                  className="block rounded-lg border border-zinc-200 bg-white p-3 hover:border-zinc-400"
                >
                  <span className="text-sm font-medium">
                    {displayName(entity, id)}
                  </span>
                  {asString(entity.attributes.next_action) && (
                    <span className="mt-0.5 block text-xs text-zinc-600">
                      Next: {asString(entity.attributes.next_action)}
                    </span>
                  )}
                  {asString(entity.attributes.floor) && (
                    <span className="mt-0.5 block text-xs text-zinc-500">
                      Floor: {asString(entity.attributes.floor)}
                    </span>
                  )}
                </Link>
              </li>
            ),
          )}
        </ul>
      )}
    </Section>
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
            missing ? (
              <Gone key={id} id={id} noun="appointment" />
            ) : !entity ? (
              <Pending key={id} />
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
                      {displayName(entity, id)}
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

/** EP1: the one descriptive episodes line the briefing already composed — a
 * count in words, historical language only. Text the job wrote, not ids, so
 * there is nothing to resolve; absent entirely when there is nothing to say. */
export function Episodes({ line }: { line?: string }) {
  if (!line) return null;
  return (
    <Section title="Episodes">
      <p className="text-sm text-zinc-600">{line}</p>
    </Section>
  );
}

/** Monday edition only (ADR 019 rule 9): check-in days per week over the four
 * complete weeks behind it — counts and a verdict, no narration. */
export function GateStatus({ gate }: { gate?: Gate }) {
  if (!gate) return null;
  return (
    <Section title="Utility gate">
      <p className="text-sm text-zinc-600">
        {gate.met ? "Met" : "Open"} — check-in days per week:{" "}
        {gate.weeks.join(" · ")}
      </p>
    </Section>
  );
}
