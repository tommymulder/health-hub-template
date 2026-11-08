import { describe, it, expect } from "vitest";
import { sleepHeartRateRows } from "@/core/oura/sync";

describe("sleepHeartRateRows (a sleep document's 5-minute series -> timeline readings)", () => {
  const doc = { heart_rate: { interval: 300, timestamp: "2026-10-19T22:18:29.000-07:00", items: [null, 61.4, 60, null, 58.6] } };
  it("puts item i at timestamp + i x interval, skips nulls, rounds bpm, source oura:sleep", () => {
    const rows = sleepHeartRateRows(doc);
    expect(rows).toEqual([
      { timestamp: "2026-10-20T05:23:29.000Z", bpm: 61, source: "sleep" }, // 22:18:29 PDT + 5 min = 05:23:29Z
      { timestamp: "2026-10-20T05:28:29.000Z", bpm: 60, source: "sleep" },
      { timestamp: "2026-10-20T05:38:29.000Z", bpm: 59, source: "sleep" },
    ]);
  });
  it("returns nothing for a document with no usable series", () => {
    expect(sleepHeartRateRows({})).toEqual([]);
    expect(sleepHeartRateRows({ heart_rate: { interval: 300, timestamp: "garbage", items: [60] } })).toEqual([]);
    expect(sleepHeartRateRows({ heart_rate: { interval: 0, timestamp: "2026-10-19T22:18:29.000-07:00", items: [60] } })).toEqual([]);
    expect(sleepHeartRateRows({ heart_rate: { interval: 300, timestamp: "2026-10-19T22:18:29.000-07:00", items: "<omitted>" } })).toEqual([]);
  });
});
