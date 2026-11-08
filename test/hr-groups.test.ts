import { describe, it, expect } from "vitest";
import { heartRateGroups, parseWindowEdge } from "@/core/hr/groups";

const TZ = "America/Los_Angeles";
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("parseWindowEdge (no offset means Pacific; a date-only end means the end of that day)", () => {
  it("date-only start = local midnight", () => expect(iso(parseWindowEdge("2026-10-17", "start", TZ))).toBe("2026-10-17T07:00:00.000Z"));
  it("date-only end = local midnight of the NEXT day", () => expect(iso(parseWindowEdge("2026-10-17", "end", TZ))).toBe("2026-10-18T07:00:00.000Z"));
  it("a date-time without offset is Pacific", () => expect(iso(parseWindowEdge("2026-10-19T22:00", "start", TZ))).toBe("2026-10-20T05:00:00.000Z"));
  it("an explicit offset or Z is honoured", () => {
    expect(iso(parseWindowEdge("2026-10-19T22:00:00Z", "start", TZ))).toBe("2026-10-19T22:00:00.000Z");
    expect(iso(parseWindowEdge("2026-10-19T22:00:00-04:00", "end", TZ))).toBe("2026-10-20T02:00:00.000Z");
  });
  it("rejects garbage", () => expect(() => parseWindowEdge("yesterday", "start", TZ)).toThrow(/date/i));
});

describe("heartRateGroups", () => {
  it("none = one group covering the window", () => {
    const s = Date.parse("2026-10-17T20:00:00Z"), e = Date.parse("2026-10-18T03:00:00Z");
    expect(heartRateGroups(s, e, "none", TZ)).toEqual([{ from: s, to: e }]);
  });
  it("day: a window crossing local midnight splits there, and the ends are clipped to the window", () => {
    const s = parseWindowEdge("2026-10-17T22:00", "start", TZ), e = parseWindowEdge("2026-10-18T02:00", "end", TZ);
    const g = heartRateGroups(s, e, "day", TZ);
    expect(g.map((x) => [iso(x.from), iso(x.to)])).toEqual([
      ["2026-10-18T05:00:00.000Z", "2026-10-18T07:00:00.000Z"], // 22:00-24:00 Oct 17 Pacific
      ["2026-10-18T07:00:00.000Z", "2026-10-18T09:00:00.000Z"], // 00:00-02:00 Oct 18
    ]);
  });
  it("the DST fall-back day (2026-11-01) is 25 hours long", () => {
    const g = heartRateGroups(parseWindowEdge("2026-10-31", "start", TZ), parseWindowEdge("2026-11-02", "end", TZ), "day", TZ);
    expect(g.map((x) => (x.to - x.from) / H)).toEqual([24, 25, 24]);
  });
  it("the spring-forward day (2027-03-14) is 23 hours long", () => {
    const g = heartRateGroups(parseWindowEdge("2027-03-14", "start", TZ), parseWindowEdge("2027-03-14", "end", TZ), "day", TZ);
    expect(g.map((x) => (x.to - x.from) / H)).toEqual([23]);
  });
  it("week starts on Monday (local midnight), first and last weeks clipped", () => {
    // Wed 2026-10-14 .. Tue 2026-10-20
    const g = heartRateGroups(parseWindowEdge("2026-10-14", "start", TZ), parseWindowEdge("2026-10-20", "end", TZ), "week", TZ);
    expect(g.map((x) => [iso(x.from), iso(x.to)])).toEqual([
      ["2026-10-14T07:00:00.000Z", "2026-10-19T07:00:00.000Z"], // Wed..Sun
      ["2026-10-19T07:00:00.000Z", "2026-10-21T07:00:00.000Z"], // Mon, Tue
    ]);
  });
  it("hour: whole local hours, 25 on the fall-back day", () => {
    const g = heartRateGroups(parseWindowEdge("2026-11-01", "start", TZ), parseWindowEdge("2026-11-01", "end", TZ), "hour", TZ);
    expect(g).toHaveLength(25);
    expect(g.every((x) => x.to - x.from === H)).toBe(true);
  });
});
