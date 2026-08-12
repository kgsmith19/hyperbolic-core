export function ApiError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p data-testid="api-error" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      ⚠ Can't reach ACC — {error instanceof Error ? error.message : "network error"}
    </p>
  );
}
