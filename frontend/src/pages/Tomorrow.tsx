// The Tomorrow Cockpit: the assembled briefing, resolved for reading.
//
// A briefing stores only entity IDs — no titles, no times, no names (ADR 014):
// copied text would outlive the entity it was copied from, survive forget(),
// and stay full-text searchable. So the display data lives only in the cited
// entities, and this page resolves every id at read time through /entities/{id}.
// A briefing is a pointer: an id that no longer resolves is shown as gone
// rather than guessed at. Read-only — this page writes nothing.
//
// Recomposed in INT1 (ADR 019 rule 1): the one morning digest — the focus
// intentions first, today's appointments second, then the EP1 episodes line on
// the days the job wrote one. The Monday edition adds the utility-gate counts.
// The episodes line and the gate are both values the briefing computed, not
// ids, so neither resolves anything. Keys an old-composition briefing left behind
// (open_review_ids, latest_checkin_id) are ignored: feelings are pull-only.
import { useQueries, useQuery } from "@tanstack/react-query";

import { getEntity, searchEntities, type Entity } from "../api/client";
import { asGate, asIds, asString, type Attributes } from "../attributes";
import {
  Appointments,
  Empty,
  Episodes,
  FocusIntentions,
  GateStatus,
  type Resolved,
} from "../components/BriefingSections";
import { ErrorText, Loading } from "../components/QueryStatus";

/**
 * The newest briefing that exists — never a briefing looked up by a date this
 * browser computed. The job keys each briefing by its own day in
 * LIFEOS_BRIEFING_TZ (domains/ops/briefing.py); a browser in another zone, or
 * one an hour past local midnight, would ask for a key the server never wrote
 * and get an empty result that reads exactly like "the job never ran".
 */
function newest(briefings: Entity[] | undefined): Entity | undefined {
  const rank = (item: Entity) =>
    `${asString(item.attributes.date) ?? ""} ${item.created_at}`;
  return briefings?.reduce(
    (best: Entity | undefined, item) =>
      best && rank(best) >= rank(item) ? best : item,
    undefined,
  );
}

export default function Tomorrow() {
  const briefings = useQuery({
    queryKey: ["briefing", "latest"],
    queryFn: () => searchEntities({ type_name: "briefing" }),
  });

  const attributes: Attributes | undefined = newest(briefings.data)?.attributes;
  const focusIds = asIds(attributes?.focus_intention_ids);
  const appointmentIds = asIds(attributes?.appointment_ids);
  const citedIds = [...focusIds, ...appointmentIds];

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

  if (briefings.isPending) return <Loading />;
  if (briefings.isError) return <ErrorText error={briefings.error} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Tomorrow Cockpit</h1>
        <p className="text-sm text-zinc-500">
          {attributes
            ? // The briefing's own date, so the page never claims a day the
              // briefing does not cover.
              `Briefing for ${asString(attributes.date) ?? "an unrecorded day"}`
            : "Nothing assembled yet"}
        </p>
      </div>

      {!attributes ? (
        <Empty>
          No briefing yet — the daily job assembles one once it runs.
        </Empty>
      ) : (
        <>
          <FocusIntentions items={focusIds.map(resolve)} />
          <Appointments items={appointmentIds.map(resolve)} />
          <Episodes line={asString(attributes.episodes_line)} />
          <GateStatus gate={asGate(attributes.gate)} />
        </>
      )}
    </div>
  );
}
