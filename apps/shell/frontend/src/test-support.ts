// Shared helpers for the src/lib data-access tests. Sits beside test-setup.ts
// rather than in src/lib/ so nothing here looks like application code; the
// vitest `include` glob only collects *.test.ts, so this file is never
// mistaken for a suite of its own.
import { vi } from "vitest";

const JSON_HEADERS = { "content-type": "application/json" };

/** Stub global fetch with a single JSON response, and hand back the spy so the
 *  caller can assert on the exact request that was made. */
export function mockFetchJson(status: number, body: unknown) {
  const response = new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
  const spy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Stub global fetch with one JSON response per call, in order. Each is built
 *  inside its own mockImplementationOnce rather than up front, because a
 *  Response body is a stream that can only be consumed once -- pre-building
 *  them would make the second read of a repeated body come back empty. */
export function mockFetchSequence(bodies: Array<{ status: number; body: unknown }>) {
  const spy = vi.fn();
  for (const { status, body } of bodies) {
    spy.mockImplementationOnce(
      async () => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
    );
  }
  vi.stubGlobal("fetch", spy);
  return spy;
}
