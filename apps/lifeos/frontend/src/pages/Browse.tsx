import { Button, Input, Select } from "@hyperbolic/ui";
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
        <Input name="text" placeholder="Search…" className="flex-1" />
        <Select name="type_name" wrapperClassName="w-48 shrink-0">
          <option value="">All types</option>
          {types.data?.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </Select>
        <Button type="submit" className="shrink-0">
          Search
        </Button>
      </form>

      {results.isPending && <Loading />}
      {results.isError && <ErrorText error={results.error} />}
      <ul className="space-y-2">
        {results.data?.map((entity) => (
          <li key={entity.id}>
            <Link
              to={`/entities/${entity.id}`}
              className="block rounded-lg border border-border bg-surface p-3 hover:border-border-strong"
            >
              <span className="font-medium">{entity.name ?? entity.id}</span>
              <span className="mt-1 block truncate text-xs text-text-muted">
                {JSON.stringify(entity.attributes)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {results.data?.length === 0 && (
        <p className="text-sm text-text-muted">No results.</p>
      )}
    </div>
  );
}
