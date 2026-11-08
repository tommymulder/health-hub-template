import { describe, it, expect, vi } from "vitest";
import { createOuraClient } from "@/core/oura/client";
import { OuraDeniedError } from "@/core/oura/tokens";

const res = (status: number, json: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(json), { status, headers });

function client(responses: (Response | Error)[], over: { refresh?: (t: string) => Promise<string> } = {}) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async () => {
    const r = queue.shift()!;
    if (r instanceof Error) throw r;
    return r;
  });
  const sleep = vi.fn(async () => {});
  const forceRefresh = vi.fn(over.refresh ?? (async () => "NEW"));
  const api = createOuraClient({ getAccessToken: async () => "OLD", forceRefresh, fetchImpl: fetchImpl as never, sleep, maxRetries: 2 });
  return { api, fetchImpl, sleep, forceRefresh };
}
const urlOf = (f: ReturnType<typeof client>["fetchImpl"], n = 0) => (f.mock.calls[n] as unknown as [URL, RequestInit])[0];
const headersOf = (f: ReturnType<typeof client>["fetchImpl"], n = 0) => (f.mock.calls[n] as unknown as [URL, RequestInit])[1].headers as Record<string, string>;

describe("Oura client", () => {
  it("GETs a usercollection endpoint with a bearer token and date range", async () => {
    const { api, fetchImpl } = client([res(200, { data: [{ id: "a" }], next_token: null })]);
    expect(await api.collection("daily_readiness", { start_date: "2026-10-01", end_date: "2026-10-10" })).toEqual([{ id: "a" }]);
    const u = urlOf(fetchImpl);
    expect(u.pathname).toBe("/v2/usercollection/daily_readiness");
    expect(u.searchParams.get("start_date")).toBe("2026-10-01");
    expect(headersOf(fetchImpl).authorization).toBe("Bearer OLD");
  });

  it("follows next_token across pages", async () => {
    const { api, fetchImpl } = client([res(200, { data: [{ id: "a" }], next_token: "T2" }), res(200, { data: [{ id: "b" }], next_token: null })]);
    expect((await api.collection("sleep", { start_date: "x", end_date: "y" })).map((d) => d.id)).toEqual(["a", "b"]);
    expect(urlOf(fetchImpl, 1).searchParams.get("next_token")).toBe("T2");
  });

  it("fetches heart rate by datetime", async () => {
    const { api, fetchImpl } = client([res(200, { data: [{ timestamp: "2026-10-11T00:05:42.000Z", bpm: 79, source: "awake" }], next_token: null })]);
    const rows = await api.heartRate("2026-10-10T00:00:00Z", "2026-10-11T00:00:00Z");
    expect(rows[0].bpm).toBe(79);
    expect(urlOf(fetchImpl).searchParams.get("start_datetime")).toBe("2026-10-10T00:00:00Z");
  });

  it("on 401, force-refreshes ONCE and retries with the new token", async () => {
    const { api, fetchImpl, forceRefresh } = client([res(401), res(200, { data: [], next_token: null })]);
    await api.collection("daily_sleep", { start_date: "a", end_date: "b" });
    expect(forceRefresh).toHaveBeenCalledOnce();
    expect(forceRefresh).toHaveBeenCalledWith("OLD");
    expect(headersOf(fetchImpl, 1).authorization).toBe("Bearer NEW");
  });

  it("a second 401 (after a SUCCESSFUL refresh) means this endpoint is denied, not that the login is lost: no loop", async () => {
    const { api, fetchImpl, forceRefresh } = client([res(401), res(401), res(200)]);
    await expect(api.collection("daily_resilience", { start_date: "a", end_date: "b" })).rejects.toBeInstanceOf(OuraDeniedError);
    await expect(client([res(401), res(401)]).api.collection("vO2_max", { start_date: "a", end_date: "b" })).rejects.toThrow(/vO2_max.*401/);
    expect(forceRefresh).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 429/5xx and network errors with backoff, honouring Retry-After", async () => {
    const { api, fetchImpl, sleep } = client([res(429, {}, { "retry-after": "2" }), new Error("ECONNRESET"), res(200, { data: [], next_token: null })]);
    await api.collection("daily_sleep", { start_date: "a", end_date: "b" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
  });

  it("gives up after maxRetries and does not retry client errors", async () => {
    const a = client([res(500), res(500), res(500), res(200)]);
    await expect(a.api.collection("sleep", { start_date: "a", end_date: "b" })).rejects.toThrow(/500/);
    expect(a.fetchImpl).toHaveBeenCalledTimes(3);
    const b = client([res(400, { detail: "bad range" }), res(200)]);
    await expect(b.api.heartRate("x", "y")).rejects.toThrow(/400.*bad range/);
    expect(b.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a request Oura never answers times out and counts as a network error (it can't hold up a call)", async () => {
    const hangingFetch = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  }));
    const api = createOuraClient({ getAccessToken: async () => "T", forceRefresh: async () => "N", fetchImpl: hangingFetch as never, sleep: async () => {}, maxRetries: 1, timeoutMs: 20 });
    const t0 = Date.now();
    await expect(api.collection("sleep", { start_date: "a", end_date: "b" })).rejects.toThrow(/Oura network error/);
    expect(hangingFetch).toHaveBeenCalledTimes(2); // 1 try + 1 retry, each cut off after 20 ms
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("only ever issues GETs to usercollection (webhooks are unreachable)", async () => {
    const { api, fetchImpl } = client([res(200, { data: [], next_token: null })]);
    await api.collection("workout", { start_date: "a", end_date: "b" });
    const init = (fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(init.method ?? "GET").toBe("GET");
    await expect(api.collection("../webhook/subscription" as never, { start_date: "a", end_date: "b" })).rejects.toThrow(/Refusing/);
  });
});
