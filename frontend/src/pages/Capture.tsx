import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type SubmitEvent } from "react";
import { useNavigate } from "react-router";

import { captureEntity, listTypes } from "../api/client";

type FieldSchema = { type?: string };
type ObjectSchema = {
  properties?: Record<string, FieldSchema>;
  required?: string[];
};

export default function Capture() {
  const navigate = useNavigate();
  const types = useQuery({ queryKey: ["types"], queryFn: listTypes });
  const [typeName, setTypeName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selected = types.data?.find((t) => t.name === typeName);
  const schema = selected?.json_schema as ObjectSchema | undefined;
  const fields = schema?.properties ?? null;
  const required = new Set(schema?.required ?? []);

  const capture = useMutation({
    mutationFn: captureEntity,
    onSuccess: (result) => void navigate(`/entities/${result.entity_id}`),
  });

  function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const attributes: Record<string, unknown> = {};
    try {
      if (fields) {
        for (const [name, field] of Object.entries(fields)) {
          const raw = String(form.get(name) ?? "").trim();
          if (!raw) continue;
          if (field.type === "number" || field.type === "integer") {
            const parsed = Number(raw);
            if (Number.isNaN(parsed)) {
              setError(`${name} must be a number`);
              return;
            }
            attributes[name] = parsed;
          } else if (field.type === "string") attributes[name] = raw;
          else attributes[name] = JSON.parse(raw);
        }
      } else {
        Object.assign(
          attributes,
          JSON.parse(String(form.get("attributes") ?? "{}")),
        );
      }
    } catch (parseError) {
      setError(`Invalid JSON: ${String(parseError)}`);
      return;
    }
    capture.mutate({ type_name: typeName, attributes });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block text-sm">
        Type
        <select
          value={typeName}
          onChange={(event) => setTypeName(event.target.value)}
          required
          className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
        >
          <option value="">Choose a type…</option>
          {types.data?.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.domain})
            </option>
          ))}
        </select>
      </label>

      {typeName && fields && (
        <div className="space-y-3">
          {Object.entries(fields).map(([name, field]) => (
            <label key={name} className="block text-sm">
              {name}
              {required.has(name) && <span className="text-red-500"> *</span>}
              {field.type === "string" ||
              field.type === "number" ||
              field.type === "integer" ? (
                <input
                  name={name}
                  required={required.has(name)}
                  inputMode={field.type === "string" ? undefined : "decimal"}
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5"
                />
              ) : (
                <textarea
                  name={name}
                  required={required.has(name)}
                  placeholder='JSON, e.g. ["a", "b"]'
                  className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 font-mono text-xs"
                  rows={2}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {typeName && !fields && (
        <label className="block text-sm">
          Attributes (JSON)
          <textarea
            name="attributes"
            defaultValue="{}"
            className="mt-1 w-full rounded border border-zinc-300 px-2 py-1.5 font-mono text-xs"
            rows={6}
          />
        </label>
      )}

      {(error ?? capture.error) && (
        <p role="alert" className="text-sm text-red-600">
          {error ?? String(capture.error)}
        </p>
      )}
      <button
        type="submit"
        disabled={!typeName || capture.isPending}
        className="rounded bg-zinc-900 px-4 py-1.5 text-white disabled:opacity-50"
      >
        Capture
      </button>
    </form>
  );
}
