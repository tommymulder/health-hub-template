import { describe, it, expect, vi } from "vitest";
import { createHevyClient, HevyError } from "@/core/hevy/client";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (s: number, headers: Record<string, string> = {}) => new Response("", { status: s, headers });
const page = { page: 1, page_count: 1, workouts: [] };

function client(responses: (Response | Error)[]) {
  const fetchImpl = vi.fn(async () => {
    const r = responses.shift()!;
    if (r instanceof Error) throw r;
    return r;
  });
  const sleep = vi.fn(async () => {});
  return { fetchImpl, sleep, api: createHevyClient({ apiKey: "k", fetchImpl: fetchImpl as never, sleep, maxRetries: 3 }) };
}

describe("Hevy client", () => {
  it("sends the api-key header and pagination params", async () => {
    const { api, fetchImpl } = client([ok(page)]);
    await api.getWorkoutsPage(3);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/workouts");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("k");
  });

  it("passes `since` to the events endpoint", async () => {
    const { api, fetchImpl } = client([ok({ page: 1, page_count: 1, events: [] })]);
    await api.getEventsPage("2026-10-01T00:00:00Z", 1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("since")).toBe("2026-10-01T00:00:00Z");
  });

  it("treats the real API's empty events reply ({workouts: []}) as no events", async () => {
    // Recorded shape from the live API on 2026-10-11 (spec says `events`).
    const { api } = client([ok({ page: 1, page_count: 1, workouts: [] })]);
    await expect(api.getEventsPage("2030-01-01T00:00:00Z", 1)).resolves.toMatchObject({ items: [], page_count: 1 });
  });

  it("fails loudly on an unexpected events shape instead of dropping data", async () => {
    const { api } = client([ok({ page: 1, page_count: 1, workouts: [{ id: "x" }] })]);
    await expect(api.getEventsPage("2026-01-01T00:00:00Z", 1)).rejects.toBeInstanceOf(HevyError);
    const bad = client([ok({ page: 1, page_count: 1 })]);
    await expect(bad.api.getEventsPage("2026-01-01T00:00:00Z", 1)).rejects.toBeInstanceOf(HevyError);
  });

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const { api, fetchImpl, sleep } = client([status(429), status(503), ok(page)]);
    await expect(api.getWorkoutsPage(1)).resolves.toMatchObject({ page_count: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it("honors Retry-After", async () => {
    const { api, sleep } = client([status(429, { "retry-after": "2" }), ok(page)]);
    await api.getWorkoutsPage(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("retries network errors", async () => {
    const { api, fetchImpl } = client([new Error("ECONNRESET"), ok(page)]);
    await api.getWorkoutsPage(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry 401/404", async () => {
    for (const s of [401, 404]) {
      const { api, fetchImpl } = client([status(s), ok(page)]);
      await expect(api.getWorkoutsPage(1)).rejects.toMatchObject({ status: s });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("a request Hevy never answers times out and counts as a network error (it can't hold up a call)", async () => {
    const hangingFetch = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  }));
    const api = createHevyClient({ apiKey: "k", fetchImpl: hangingFetch as never, sleep: async () => {}, maxRetries: 1, timeoutMs: 20 });
    const t0 = Date.now();
    await expect(api.getWorkoutsPage(1)).rejects.toThrow(/Hevy network error/);
    expect(hangingFetch).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("gives up after maxRetries", async () => {
    const { api, fetchImpl } = client([status(500), status(500), status(500), status(500), ok(page)]);
    await expect(api.getWorkoutsPage(1)).rejects.toBeInstanceOf(HevyError);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 try + 3 retries
  });

  it("only ever issues GETs", async () => {
    const { api, fetchImpl } = client([ok(page), ok({ workout_count: 7 })]);
    await api.getWorkoutsPage(1);
    await api.getWorkoutCount();
    for (const call of fetchImpl.mock.calls as unknown as [URL, RequestInit][]) {
      expect(call[1].method ?? "GET").toBe("GET");
    }
  });
});
