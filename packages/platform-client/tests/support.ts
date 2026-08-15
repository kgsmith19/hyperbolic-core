// Shared helpers for this package's suites. Not named *.test.ts on purpose:
// the test script globs tests/, so this file is a module the suites import,
// never a suite of its own.

/** A JSON Response, the shape every fetch stub in these tests hands back.
 *  The content-type matters -- the clients under test branch on it, so a
 *  stub without it would exercise a different path than production does. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
