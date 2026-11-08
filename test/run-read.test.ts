import { describe, it, expect, vi } from "vitest";
import type { FreshnessReport } from "@/core/freshness";
import { withDeadline, TIMED_OUT } from "@/core/deadline";
import { ToolError } from "@/core/tools/context";
import { runRead } from "@/core/tools/run";

const fresh = (over: Partial<FreshnessReport> = {}): FreshnessReport => ({
  hevy: { asOf: "2026-10-11T18:00:00.000Z", refreshed: false }, oura: { asOf: "2026-10-11T17:00:00.000Z", refreshed: true }, ...over,
});
const never = () => new Promise<never>(() => {});

describe("withDeadline", () => {
  it("returns the result when the work is in time, TIMED_OUT when it isn't", async () => {
    expect(await withDeadline(Promise.resolve(7), 50)).toBe(7);
    expect(await withDeadline(never(), 20)).toBe(TIMED_OUT);
  });
  it("passes a failure through", async () => {
    await expect(withDeadline(Promise.reject(new Error("x")), 50)).rejects.toThrow("x");
  });
});

describe("runRead: every read tool answers in time, with as_of and one log line", () => {
  it("adds as_of (and the Oura one only for Oura tools) and joins the freshness notes", async () => {
    const lines: string[] = [];
    const out = await runRead({
      tool: "get_trends", oura: true, log: (l) => lines.push(l),
      refresh: async () => fresh({ hevy: { asOf: null, refreshed: false, note: "Hevy note." } }),
      query: async () => ({ weeks: 12 }),
    }) as Record<string, any>;
    expect(out).toMatchObject({ weeks: 12, as_of: { hevy: null, oura: "2026-10-11T17:00:00.000Z" }, data_freshness_note: "Hevy note." });
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0].replace(/^tool /, ""));
    expect(logged).toMatchObject({ tool: "get_trends", outcome: "ok", refreshed: { hevy: false, oura: true } });
    expect(Object.keys(logged).sort()).toEqual(["ms", "outcome", "refresh_ms", "refreshed", "tool"]); // status only, no data

    const hevyOnly = await runRead({ tool: "get_body_metrics", oura: false, log: () => {}, refresh: async () => fresh({ oura: null }), query: async () => ({}) }) as Record<string, any>;
    expect(hevyOnly.as_of).toEqual({ hevy: "2026-10-11T18:00:00.000Z" });
  });

  it("a stuck query becomes a clear error within the deadline, says which part was stuck, and resets the connection", async () => {
    const lines: string[] = [];
    const onDeadline = vi.fn();
    const t0 = Date.now();
    const p = runRead({ tool: "get_trends", oura: true, deadlineMs: 50, onDeadline, log: (l) => lines.push(l), refresh: async () => fresh(), query: never });
    await expect(p).rejects.toThrow(ToolError);
    await expect(p).rejects.toThrow(/stuck while reading the database/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(onDeadline).toHaveBeenCalledOnce();
    expect(JSON.parse(lines[0].replace(/^tool /, ""))).toMatchObject({ tool: "get_trends", outcome: "deadline", phase: "reading the database" });
  });

  it("a stuck refresh is reported as such", async () => {
    const lines: string[] = [];
    await expect(runRead({ tool: "get_recovery", oura: true, deadlineMs: 30, log: (l) => lines.push(l), refresh: never, query: async () => ({}) }))
      .rejects.toThrow(/stuck while refreshing data/);
    expect(JSON.parse(lines[0].replace(/^tool /, ""))).toMatchObject({ outcome: "deadline", phase: "refreshing data", refreshed: null });
  });

  it("passes a ToolError through unchanged (the caller turns it into a plain message) and logs it without its text", async () => {
    const lines: string[] = [];
    await expect(runRead({ tool: "get_trends", oura: true, log: (l) => lines.push(l), refresh: async () => fresh(), query: async () => { throw new ToolError("No Oura data is stored for that window yet."); } }))
      .rejects.toThrow("No Oura data");
    expect(JSON.parse(lines[0].replace(/^tool /, ""))).toMatchObject({ outcome: "error", error: "ToolError" });
  });
});
