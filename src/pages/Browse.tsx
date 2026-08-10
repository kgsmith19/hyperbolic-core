import { useQuery } from "@tanstack/react-query";
import { useState, type SubmitEvent } from "react";
import { Link } from "react-router";

import { listTypes, searchEntities } from "../api/client";
import { ErrorText, Loading } from "../components/QueryStatus";

export default function Browse() {
  const [filters, setFilters] = useState<{ text?: string; type_name?: string }>(
    {},
  );
  const types = useQuery({ queryKey: ["types"], queryFn: listTypes });
  const results = useQuery({
    queryKey: ["search", filters],
    queryFn: () => searchEntities(filters),
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setFilters({
      text: String(form.get("text")) || undefined,
      type_name: String(form.get("type_name")) || undefined,
    });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          name="text"
          placeholder="Search…"
          className="flex-1 rounded border border-zinc-300 px-2 py-1.5"
        />
        <select
          name="type_name"
          className="rounded border border-zinc-300 px-2 py-1.5"
        >
          <option value="">All types</option>
          {types.data?.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded bg-zinc-900 px-3 text-white">
          Search
        </button>
      </form>

      {results.isPending && <Loading />}
      {results.isError && <ErrorText error={results.error} />}
      <ul className="space-y-2">
        {results.data?.map((entity) => (
          <li key={entity.id}>
            <Link
              to={`/entities/${entity.id}`}
              className="block rounded-lg border border-zinc-200 bg-white p-3 hover:border-zinc-400"
            >
              <span className="font-medium">{entity.name ?? entity.id}</span>
              <span className="mt-1 block truncate text-xs text-zinc-500">
                {JSON.stringify(entity.attributes)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {results.data?.length === 0 && (
        <p className="text-sm text-zinc-500">No results.</p>
      )}
    </div>
  );
}
