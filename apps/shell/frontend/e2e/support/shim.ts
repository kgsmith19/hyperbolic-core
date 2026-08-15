// Shared pieces of the PostgREST-shaped shims the e2e fixtures stand up, and
// of the specs that proxy requests into them.

/** What a shim returns instead of a row set when the underlying SQL raised. */
export interface ShimError {
  status: number;
  message: string;
}

/** Turn a psql failure into a shim response. psql's stderr carries the text of
 *  a RAISE EXCEPTION (e.g. "II-1: illegal transition draft ->
 *  submitted_to_github") after "ERROR:  ", which is the part a test actually
 *  asserts on; everything before it is psql framing. */
export function sqlErrorToShimError(err: unknown): ShimError {
  const raw = err instanceof Error ? err.message : String(err);
  const match = /ERROR:\s+(.*)/.exec(raw);
  return { status: 400, message: (match?.[1] ?? raw).trim() };
}

/** Narrow a request's headers to `names`, dropping absent ones.
 *
 *  The list is a parameter rather than a constant because the specs genuinely
 *  forward different sets -- a spec that also asserts on the request BODY
 *  needs content-type and prefer, and one that only reads rows does not.
 *  Forwarding a header a spec does not assert on would make the proxy, not the
 *  app, the thing under test. */
export function pickHeaders(
  all: Record<string, string>,
  names: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = all[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
