import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";

import { forgetEntity, getEntity, getHistory } from "../api/client";
import { ErrorText, Loading } from "../components/QueryStatus";

export default function EntityDetail() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ["entity", id],
    queryFn: () => getEntity(id),
  });
  const events = useQuery({
    queryKey: ["history", id],
    queryFn: () => getHistory(id),
  });
  const forget = useMutation({
    mutationFn: () => forgetEntity(id),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  if (view.isPending) return <Loading />;
  if (view.isError) return <ErrorText error={view.error} />;
  const { entity, types, edges_out, edges_in } = view.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{entity.name ?? entity.id}</h1>
        <p className="text-sm text-zinc-500">{types.join(" · ")}</p>
      </div>

      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase text-zinc-500">
          Attributes
        </h2>
        <dl className="rounded-lg border border-zinc-200 bg-white p-3">
          {Object.entries(entity.attributes).map(([key, value]) => (
            <div key={key} className="flex gap-2 py-0.5 text-sm">
              <dt className="w-40 shrink-0 font-medium">{key}</dt>
              <dd className="break-all text-zinc-700">
                {JSON.stringify(value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {(edges_out.length > 0 || edges_in.length > 0) && (
        <section>
          <h2 className="mb-1 text-sm font-semibold uppercase text-zinc-500">
            Edges
          </h2>
          <ul className="space-y-1 text-sm">
            {edges_out.map((edge) => (
              <li key={edge.id}>
                → {edge.relation}{" "}
                <Link
                  to={`/entities/${edge.to_entity}`}
                  className="text-blue-700 hover:underline"
                >
                  {edge.to_entity}
                </Link>
              </li>
            ))}
            {edges_in.map((edge) => (
              <li key={edge.id}>
                ←{" "}
                <Link
                  to={`/entities/${edge.from_entity}`}
                  className="text-blue-700 hover:underline"
                >
                  {edge.from_entity}
                </Link>{" "}
                {edge.relation}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase text-zinc-500">
          History
        </h2>
        {events.isError && <ErrorText error={events.error} />}
        <ol className="space-y-1 text-sm">
          {events.data?.map((event) => (
            <li
              key={event.id}
              className="rounded border border-zinc-200 bg-white px-2 py-1"
            >
              <span className="font-medium">{event.event_type}</span>
              <span className="ml-2 text-zinc-500">
                {new Date(event.recorded_at).toLocaleString()} · {event.actor}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-t border-zinc-200 pt-3">
        <button
          onClick={() => {
            if (
              window.confirm(
                "Erase every PII-flagged field on this entity? This cannot be undone.",
              )
            )
              forget.mutate();
          }}
          className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
        >
          Forget (erase PII)
        </button>
        {forget.isSuccess && (
          <p className="mt-2 text-sm text-zinc-600">
            Erased {forget.data.fields.join(", ")} across{" "}
            {forget.data.events_redacted} event(s).
          </p>
        )}
        {forget.isError && (
          <p className="mt-2 text-sm text-red-600">{String(forget.error)}</p>
        )}
      </section>
    </div>
  );
}
