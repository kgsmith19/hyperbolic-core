import { afterEach, describe, expect, it, vi } from "vitest";

import { getEntity, health, searchEntities } from "./client";
import { supabase } from "../auth/supabase";

vi.mock("../auth/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi
        .fn()
        .mockResolvedValue({ data: { session: { access_token: "tok-123" } } }),
      signOut: vi.fn().mockResolvedValue({}),
    },
  },
}));

function mockFetch(status: number, body: unknown) {
  const response = new Response(JSON.stringify(body), { status });
  const spy = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("attaches the bearer token from the session", async () => {
    const spy = mockFetch(200, { status: "ok" });
    await health();
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok-123" });
  });

  it("builds search query params, dropping empty values", async () => {
    const spy = mockFetch(200, []);
    await searchEntities({ text: "run", type_name: undefined });
    expect(String(spy.mock.calls[0][0])).toContain("/search?text=run");
  });

  it("signs out and redirects on 401", async () => {
    mockFetch(401, { detail: "invalid token" });
    const assign = vi.fn();
    vi.stubGlobal("location", { assign });
    await expect(getEntity("e1")).rejects.toThrow("signed out");
    expect(supabase.auth.signOut).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("surfaces the API detail message on errors", async () => {
    mockFetch(422, { detail: "filters must be a JSON object" });
    await expect(getEntity("e1")).rejects.toThrow(
      "filters must be a JSON object",
    );
  });
});
