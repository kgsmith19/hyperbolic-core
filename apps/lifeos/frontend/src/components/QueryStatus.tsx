// The "Loading…" / error line every page falls back to while a query settles.
// Pulled out once it repeated identically across Browse, EntityDetail,
// Approvals, Tomorrow, and the route-chunk Suspense fallback in App.

export function Loading() {
  return <p className="text-sm text-text-muted">Loading…</p>;
}

export function ErrorText({ error }: { error: unknown }) {
  return <p className="text-sm text-danger">{String(error)}</p>;
}
