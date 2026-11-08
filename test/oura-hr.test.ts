import { describe, it, expect } from "vitest";
import { DEFAULT_HR_ZONES, heartRateStats, parseHrZones, zoneLabels, zoneOf, type HrPoint } from "@/core/oura/hr";
import { getConfig } from "@/core/config";
import { baselineBefore, median, pctVsBaseline } from "@/core/oura/recovery";

const MIN = 60_000;
const T0 = Date.parse("2026-10-11T00:17:43Z"); // a workout at 5:17 PM PDT
const at = (min: number, bpm: number): HrPoint => ({ t: T0 + min * MIN, bpm });

const Z = DEFAULT_HR_ZONES;

describe("zoneOf (example Oura zones 92/111/129/148/166)", () => {
  // a zone's lower bound is INCLUSIVE
  it.each([[0, "below_z1"], [91, "below_z1"], [92, "z1"], [110, "z1"], [111, "z2"], [128, "z2"], [129, "z3"], [147, "z3"], [148, "z4"], [165, "z4"], [166, "z5"], [190, "z5"]])(
    "%i bpm -> %s", (bpm, zone) => expect(zoneOf(bpm, Z)).toBe(zone));
});

describe("HR_ZONES setting", () => {
  it("parses five rising integers", () => expect(parseHrZones("90, 110,130,150,170")).toEqual([90, 110, 130, 150, 170]));
  it.each([["92,111,129,148"], ["a,b,c,d,e"], ["92,111,111,148,166"], ["166,148,129,111,92"], ["92.5,111,129,148,166"], [""], [undefined]])(
    "falls back to the default for %s", (v) => expect(parseHrZones(v)).toEqual([...DEFAULT_HR_ZONES]));
  it("getConfig carries the zones and still defaults HR_MAX to 190 for class-window detection", () => {
    const cfg = getConfig({ DATABASE_URL: "x", HEVY_API_KEY: "y", HR_ZONES: "90,110,130,150,170" });
    expect(cfg.hrZones).toEqual([90, 110, 130, 150, 170]);
    expect(cfg.hrMax).toBe(190);
    expect(getConfig({ DATABASE_URL: "x", HEVY_API_KEY: "y" }).hrZones).toEqual([...DEFAULT_HR_ZONES]);
  });
  it("labels the zones for tool output", () =>
    expect(zoneLabels(Z)).toEqual({ z1: "92-110", z2: "111-128", z3: "129-147", z4: "148-165", z5: "166+" }));
});

describe("heartRateStats", () => {
  it("time-weights samples: each holds until the next one", () => {
    // 100 bpm for 2 min, then 150 bpm for the last 3 min of a 5-min window
    const s = heartRateStats([at(0, 100), at(2, 150)], T0, T0 + 5 * MIN, Z);
    expect(s.avg).toBe(130); // (100*2 + 150*3) / 5, NOT the plain mean of 125
    expect(s).toMatchObject({ samples: 2, min: 100, max: 150, covered_minutes: 5, window_minutes: 5 });
  });

  it("assigns minutes to the right zones (hand-computed)", () => {
    const s = heartRateStats([at(0, 100), at(2, 150), at(5, 175)], T0, T0 + 8 * MIN, Z);
    // 100 bpm = z1 for 2 min | 150 = z3 for 3 min | 175 = z5 for the last 3 min
    expect(s.minutes_by_zone).toEqual({ below_z1: 0, z1: 2, z2: 0, z3: 0, z4: 3, z5: 3 });
  });

  it("treats a long silence as a GAP, not data (5-minute cap)", () => {
    const s = heartRateStats([at(0, 120), at(20, 120)], T0, T0 + 30 * MIN, Z);
    expect(s.covered_minutes).toBe(10); // 5 after the first sample + 5 after the second, never the 30 between
    expect(s.window_minutes).toBe(30);
  });

  it("ignores samples outside the window", () => {
    const s = heartRateStats([at(-10, 200), at(1, 100), at(50, 200)], T0, T0 + 10 * MIN, Z);
    expect(s).toMatchObject({ samples: 1, max: 100 });
  });

  it("handles no samples and a single sample", () => {
    expect(heartRateStats([], T0, T0 + 10 * MIN, Z)).toMatchObject({ samples: 0, avg: null, min: null, covered_minutes: 0 });
    expect(heartRateStats([at(3, 120)], T0, T0 + 10 * MIN, Z)).toMatchObject({ samples: 1, avg: 120, covered_minutes: 5 });
  });

  it("is correct for a workout that spans the fall-back DST hour (all maths is on UTC instants)", () => {
    // 2026-11-01: 01:00-02:00 Pacific happens twice. A 90-minute workout from 01:30 PDT to 02:00 PST is 90 REAL minutes.
    const start = Date.parse("2026-11-01T08:30:00Z"); // 01:30 PDT
    const end = Date.parse("2026-11-01T10:00:00Z"); // 02:00 PST (the clock went 02:00 -> 01:00 in between)
    const pts: HrPoint[] = [0, 20, 40, 60, 80].map((m) => ({ t: start + m * MIN, bpm: 120 }));
    const s = heartRateStats(pts, start, end, Z);
    expect(s.window_minutes).toBe(90); // not 30 (wall clock) and not 150
    expect(s.samples).toBe(5);
    expect(s.avg).toBe(120);
    expect(s.minutes_by_zone.z2).toBeCloseTo(5 * 5, 5); // each 20-min-spaced sample covers its 5-minute cap
  });

  it("matches the real Oct 10 workout shape: sparse samples, resting then elevated", () => {
    // from the live Oura data: 79/83/90 at rest before, then 122..135 during the 35-minute workout
    const w0 = T0; // 00:17:43Z
    const pts: HrPoint[] = [
      { t: Date.parse("2026-10-11T00:05:42Z"), bpm: 79 },
      { t: Date.parse("2026-10-11T00:29:12Z"), bpm: 122 }, { t: Date.parse("2026-10-11T00:29:15Z"), bpm: 119 },
      { t: Date.parse("2026-10-11T00:41:21Z"), bpm: 107 }, { t: Date.parse("2026-10-11T00:43:00Z"), bpm: 135 },
      { t: Date.parse("2026-10-11T00:49:10Z"), bpm: 121 },
    ];
    const s = heartRateStats(pts, w0, w0 + 35 * MIN, Z);
    expect(s.samples).toBe(5); // the resting 79 is before the window
    expect(s.max).toBe(135);
    expect(s.min).toBe(107);
    expect(s.window_minutes).toBe(35);
    expect(s.covered_minutes).toBeLessThan(35); // sparse data is reported honestly, not stretched to fit
  });
});

describe("baselines", () => {
  const series = (n: number, v: (i: number) => number) => new Map(Array.from({ length: n }, (_, i) => [`2026-09-${String(i + 1).padStart(2, "0")}`, v(i)] as const));
  it("is the MEDIAN of the 60 days BEFORE the day, never including the day itself", () => {
    const m = series(20, () => 50);
    m.set("2026-09-21", 999);
    expect(baselineBefore(m, "2026-09-21")).toBe(50);
  });
  it("one terrible night does not drag it (that is why it is a median, not an average)", () => {
    const m = series(20, (i) => (i === 7 ? 5 : 50));
    expect(baselineBefore(m, "2026-09-21")).toBe(50);
    expect(median([5, 50, 50, 50, 50])).toBe(50);
  });
  it("median of an even count is the midpoint; junk is ignored; empty is null", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([10, NaN, 30])).toBe(20);
    expect(median([])).toBeNull();
  });
  it("only looks 60 days back, and needs at least 14 samples", () => {
    expect(baselineBefore(series(13, () => 50), "2026-09-14")).toBeNull();
    expect(baselineBefore(series(14, () => 50), "2026-09-15")).toBe(50);
    const old = new Map<string, number>([["2026-01-01", 1000], ...series(20, () => 50)]); // 2026-01-01 is far outside 60 days
    expect(baselineBefore(old, "2026-09-21")).toBe(50);
  });
  it("percent difference, rounded to 0.1", () => {
    expect(pctVsBaseline(33, 30)).toBe(10);
    expect(pctVsBaseline(27, 30)).toBe(-10);
    expect(pctVsBaseline(null, 30)).toBeNull();
    expect(pctVsBaseline(5, null)).toBeNull();
    expect(pctVsBaseline(5, 0)).toBeNull();
  });
});
