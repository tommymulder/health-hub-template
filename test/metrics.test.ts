import { describe, it, expect } from "vitest";
import {
  bestE1rm, directionFor, e1rm, hardSetCount, muscleCredit, runningPRs, sessionVolumeKg,
  setE1rm, slopePerDay, topSet, type SetInput,
} from "@/core/metrics";
import { addDays, daysBetween, weekStart } from "@/core/time";

const s = (set_type: string, weight_kg: number | null, reps: number | null, duration_s: number | null = null): SetInput =>
  ({ set_type, weight_kg, reps, duration_s });

describe("e1RM (Epley)", () => {
  it("is w × (1 + reps/30)", () => {
    expect(e1rm(100, 5)).toBeCloseTo(116.6667, 4); // 100 × (1 + 5/30)
    expect(e1rm(60, 10)).toBeCloseTo(80, 6); //  60 × (1 + 10/30)
    expect(e1rm(100, 10)).toBeCloseTo(133.3333, 4); // the cap itself is allowed
  });
  it("a single rep is its own max", () => expect(e1rm(140, 1)).toBe(140));
  it("gives no estimate above 10 reps (a real 185 x 12 would have claimed 259)", () => {
    expect(e1rm(100, 11)).toBeNull();
    expect(e1rm(83.9146, 12)).toBeNull();
  });
  it("is not meaningful without weight or reps", () => {
    expect(e1rm(null, 5)).toBeNull();
    expect(e1rm(0, 5)).toBeNull();
    expect(e1rm(100, 0)).toBeNull();
    expect(e1rm(100, null)).toBeNull();
  });
  it("counts normal and failure sets, not warm-ups or drop sets", () => {
    expect(setE1rm(s("normal", 100, 5))).not.toBeNull();
    expect(setE1rm(s("failure", 100, 5))).not.toBeNull();
    expect(setE1rm(s("warmup", 100, 5))).toBeNull();
    expect(setE1rm(s("dropset", 100, 5))).toBeNull();
  });
  it("bestE1rm takes the max over a session", () => {
    const sets = [s("warmup", 200, 5), s("normal", 100, 5), s("normal", 110, 3), s("normal", 90, 12)];
    // 100×5 = 116.67 | 110×3 = 121.0 | 90×12 = no estimate (over the cap); the 200 warm-up is ignored
    expect(bestE1rm(sets)).toBeCloseTo(121, 6);
  });
});

describe("volume and hard sets", () => {
  const sets = [s("warmup", 40, 10), s("normal", 100, 5), s("failure", 100, 4), s("dropset", 80, 6), s("normal", null, 12)];
  it("sums weight × reps over working sets only; bodyweight adds 0", () => {
    expect(sessionVolumeKg(sets)).toBe(100 * 5 + 100 * 4 + 80 * 6); // 1380
  });
  it("hard sets exclude warm-ups", () => expect(hardSetCount(sets)).toBe(4));
});

describe("topSet", () => {
  it("is the heaviest working set; ties go to more reps; warm-ups never win", () => {
    const sets = [s("warmup", 150, 3), s("normal", 100, 5), s("normal", 100, 8), s("normal", 90, 10)];
    expect(topSet(sets)).toMatchObject({ weight_kg: 100, reps: 8 });
  });
  it("assisted exercises: LEAST assistance wins, and no assist beats any assist", () => {
    expect(directionFor("bodyweight_assisted")).toBe("least_assisted");
    const sets = [s("normal", 40, 8), s("normal", 25, 6), s("normal", 25, 8)];
    expect(topSet(sets, "least_assisted")).toMatchObject({ weight_kg: 25, reps: 8 });
    expect(topSet([s("normal", 30, 5), s("normal", null, 3)], "least_assisted")).toMatchObject({ weight_kg: null });
  });
  it("falls back to most reps for bodyweight, then longest duration for holds", () => {
    expect(topSet([s("normal", null, 10), s("normal", null, 15)])).toMatchObject({ reps: 15 });
    expect(topSet([s("normal", null, null, 45), s("normal", null, null, 60)])).toMatchObject({ duration_s: 60 });
  });
  it("is null when there are no working sets", () => {
    expect(topSet([s("warmup", 50, 5)])).toBeNull();
    expect(topSet([])).toBeNull();
  });
});

describe("runningPRs", () => {
  it("flags only strict improvements; the first value is not a PR", () => {
    expect(runningPRs([100, 105, 105, 103, 110, null, 109, 111])).toEqual([false, true, false, false, true, false, false, true]);
  });
  it("handles leading nulls", () => expect(runningPRs([null, 100, 110])).toEqual([false, false, true]));
});

describe("slopePerDay", () => {
  it("recovers an exact line", () => {
    const pts = [0, 10, 20, 30].map((day) => ({ day, value: 100 + 0.5 * day }));
    expect(slopePerDay(pts)).toBeCloseTo(0.5, 10);
  });
  it("is null with fewer than 2 points or no spread in time", () => {
    expect(slopePerDay([{ day: 1, value: 5 }])).toBeNull();
    expect(slopePerDay([{ day: 3, value: 5 }, { day: 3, value: 9 }])).toBeNull();
  });
});

describe("muscleCredit", () => {
  it("gives primary 1 per set and secondary 0.5 per set", () => {
    expect(muscleCredit("chest", ["triceps", "shoulders"], 4)).toEqual({ chest: 4, triceps: 2, shoulders: 2 });
  });
  it("handles missing muscles and zero sets", () => {
    expect(muscleCredit(null, null, 3)).toEqual({});
    expect(muscleCredit("chest", [], 0)).toEqual({});
  });
});

describe("calendar helpers", () => {
  it("weekStart is the Monday of the ISO week", () => {
    expect(weekStart("2026-10-12")).toBe("2026-10-12"); // Monday
    expect(weekStart("2026-10-11")).toBe("2026-10-05"); // Sunday belongs to the week BEFORE
    expect(weekStart("2026-10-10")).toBe("2026-10-05"); // Saturday
    expect(weekStart("2026-01-01")).toBe("2025-12-29"); // crosses the year
  });
  it("addDays and daysBetween are DST-proof (pure calendar math)", () => {
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02"); // across the Nov 1 fall-back
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2); // across spring-forward
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("assisted exercises (weight = help received)", () => {
  const sets = [s("normal", 40, 8), s("normal", 30, 10)];
  it("have no e1RM and contribute no volume", () => {
    expect(bestE1rm(sets, "least_assisted")).toBeNull();
    expect(sessionVolumeKg(sets, "least_assisted")).toBe(0);
  });
  it("normal exercises are unaffected", () => {
    expect(bestE1rm(sets)).not.toBeNull();
    expect(sessionVolumeKg(sets)).toBe(40 * 8 + 30 * 10);
  });
});
