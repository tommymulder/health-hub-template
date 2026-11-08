import { describe, it, expect } from "vitest";
import { compareExercise, THRESHOLDS, type CompareSet, type ExerciseSession } from "@/core/compare/exercise";

// Synthetic sessions only. Weights are kg, times are seconds, distances are meters.
const ws = (kg: number | null, reps: number | null, over: Partial<CompareSet> = {}): CompareSet => ({ set_type: "normal", weight_kg: kg, reps, duration_s: null, distance_m: null, ...over });
const sess = (date: string, sets: CompareSet[], over: Partial<ExerciseSession> = {}): ExerciseSession => ({
  wid: `w-${date}`, date, where: "gym", assumed: false, complex: null, calories: null, sets, ...over,
});
const WEIGHTED = { type: "weight_reps" as const };

describe("thresholds are one constants block", () => {
  it("e1RM/weight 2.5%, reps/hold/distance/calories 10%, pace 2%, time at the same calories 5%", () => {
    expect(THRESHOLDS).toMatchObject({ e1rm: 2.5, weight: 2.5, reps: 10, hold: 10, distance: 10, calories: 10, pace: 2, time: 5 });
  });
});

describe("e1RM comparison (weighted, best set up to 10 reps)", () => {
  const last = sess("2031-03-01", [ws(100, 5), ws(100, 5)]); // e1RM 116.7
  it("up more than 2.5% is better, with the change", () => {
    const c = compareExercise(sess("2031-03-08", [ws(105, 5)]), [last], WEIGHTED);
    expect(c).toMatchObject({ measure: "e1rm", verdict: "better", first_time: false });
    expect(c.change!.pct).toBeCloseTo(5, 1);
    expect(c.last).toMatchObject({ date: "2031-03-01", where: "gym" });
  });
  it("down more than 2.5% is worse", () => {
    expect(compareExercise(sess("2031-03-08", [ws(95, 5)]), [last], WEIGHTED).verdict).toBe("worse");
  });
  it("a change under 2.5% is 'same': no verdict", () => {
    const c = compareExercise(sess("2031-03-08", [ws(101, 5)]), [last], WEIGHTED); // +1%
    expect(c.verdict).toBe("same");
    expect(c.change!.pct).toBeCloseTo(1, 1);
  });
  it("a single heavy rep counts as the weight itself", () => {
    const four = sess("2031-03-01", [ws(100, 4)]); // e1RM 113.3
    expect(compareExercise(sess("2031-03-08", [ws(120, 1)]), [four], WEIGHTED)).toMatchObject({ measure: "e1rm", verdict: "better" }); // 120 vs 113.3 = +5.9%
  });
  it("warm-up sets never count", () => {
    const today = sess("2031-03-08", [ws(150, 5, { set_type: "warmup" }), ws(100, 5)]);
    expect(compareExercise(today, [last], WEIGHTED).verdict).toBe("same");
  });
});

describe("like for like: the best set's reps must be within 3", () => {
  const maxOut = sess("2031-03-01", [ws(100, 8), ws(110, 5), ws(120, 3), ws(125, 3)]); // an 8-5-3-3 day
  const sets12 = (date: string, kg: number) => sess(date, [ws(kg, 12), ws(kg, 12), ws(kg, 12), ws(kg, 12)]); // a sets-of-12 day (no e1RM: above 10 reps)
  it("a 12-rep day against an 8-5-3-3 day is not compared, and says why", () => {
    const c = compareExercise(sets12("2031-03-08", 60), [maxOut], WEIGHTED);
    expect(c.verdict).toBeNull();
    expect(c.not_compared).toMatch(/12 reps today vs 3 last time/);
    expect(c.last).toMatchObject({ date: "2031-03-01" }); // both sessions are still shown
    expect(c.vs_similar).toBeUndefined();
  });
  it("finds the most recent earlier session within +-3 reps (vs_similar) in the last 180 days", () => {
    const older = sets12("2031-02-01", 55);
    const tooOld = sets12("2030-06-01", 50); // more than 180 days before today
    const c = compareExercise(sets12("2031-03-08", 60), [tooOld, older, maxOut], WEIGHTED);
    expect(c.not_compared).toBeDefined();
    expect(c.vs_similar).toMatchObject({ date: "2031-02-01", verdict: "better" }); // 60 vs 55 = +9%
    expect(c.vs_similar!.change!.pct).toBeCloseTo(9.1, 1);
  });
  it("a session older than 180 days is not used", () => {
    const c = compareExercise(sets12("2031-03-08", 60), [sets12("2030-06-01", 50), maxOut], WEIGHTED);
    expect(c.vs_similar).toBeUndefined();
  });
  it("within 3 reps it is compared directly", () => {
    const c = compareExercise(sess("2031-03-08", [ws(105, 6)]), [sess("2031-03-01", [ws(100, 8)])], WEIGHTED); // 6 vs 8
    expect(c.not_compared).toBeUndefined();
    expect(c.measure).toBe("e1rm");
  });
});

describe("a complex is compared only with the same complex", () => {
  const complexToday = sess("2031-03-08", [ws(60, 4)], { where: "class", complex: "1+1+2" });
  const straight = sess("2031-03-01", [ws(80, 5)]);
  it("a complex against straight sets is not compared", () => {
    const c = compareExercise(complexToday, [straight], WEIGHTED);
    expect(c.not_compared).toMatch(/complex/i);
    expect(c.verdict).toBeNull();
  });
  it("it is compared with the most recent earlier session of the SAME complex", () => {
    const sameComplex = sess("2031-02-01", [ws(55, 4)], { where: "class", complex: "1+1+2" });
    const c = compareExercise(complexToday, [sameComplex, straight], WEIGHTED);
    expect(c.last).toMatchObject({ date: "2031-02-01" });
    expect(c.verdict).toBe("better");
  });
  it("straight sets are never compared with a complex either", () => {
    const complexEarlier = sess("2031-03-01", [ws(60, 4)], { where: "class", complex: "1+1+2" });
    const c = compareExercise(sess("2031-03-08", [ws(80, 5)]), [complexEarlier], WEIGHTED);
    expect(c.not_compared).toMatch(/complex/i);
  });
});

describe("bodyweight (reps only)", () => {
  const BW = { type: "reps_only" as const };
  it("total reps decide", () => {
    const c = compareExercise(sess("2031-03-08", [ws(null, 20), ws(null, 18), ws(null, 15)]), [sess("2031-03-01", [ws(null, 20), ws(null, 15), ws(null, 10)])], BW);
    expect(c).toMatchObject({ measure: "reps", verdict: "better" });
    expect(c.change!.abs).toBe(8);
  });
  it("equal totals fall back to the best set", () => {
    const c = compareExercise(sess("2031-03-08", [ws(null, 30), ws(null, 20)]), [sess("2031-03-01", [ws(null, 25), ws(null, 25)])], BW); // 50 vs 50; best set 30 vs 25
    expect(c).toMatchObject({ verdict: "better", via: "best_set" });
  });
  it("equal totals and equal best sets are the same", () => {
    expect(compareExercise(sess("2031-03-08", [ws(null, 25), ws(null, 25)]), [sess("2031-03-01", [ws(null, 25), ws(null, 25)])], BW).verdict).toBe("same");
  });
  it("totals within 10% are the same", () => {
    expect(compareExercise(sess("2031-03-08", [ws(null, 52)]), [sess("2031-03-01", [ws(null, 50)])], BW).verdict).toBe("same");
  });
});

describe("holds", () => {
  const HOLD = { type: "duration" as const };
  const h = (s: number) => ws(null, null, { duration_s: s });
  it("the longest hold decides", () => {
    const c = compareExercise(sess("2031-03-08", [h(60), h(40)]), [sess("2031-03-01", [h(45), h(45)])], HOLD);
    expect(c).toMatchObject({ measure: "hold", verdict: "better" });
    expect(c.change!.abs).toBe(15);
  });
  it("a fade (40 s vs 40 s longest but less total) is judged on total time as the tie-breaker", () => {
    const c = compareExercise(sess("2031-03-08", [h(40), h(10)]), [sess("2031-03-01", [h(40), h(40), h(40)])], HOLD);
    expect(c.verdict).toBe("worse");
  });
});

describe("weighted, higher reps (snatches, wall balls): the weight used, then total reps", () => {
  const rep15 = (kg: number, n = 3) => Array.from({ length: n }, () => ws(kg, 15));
  it("weight decides", () => {
    const c = compareExercise(sess("2031-03-08", rep15(40)), [sess("2031-03-01", rep15(35))], WEIGHTED);
    expect(c).toMatchObject({ measure: "weight", verdict: "better" });
  });
  it("the same weight falls back to total reps", () => {
    const c = compareExercise(sess("2031-03-08", rep15(40, 4)), [sess("2031-03-01", rep15(40, 3))], WEIGHTED);
    expect(c.verdict).toBe("better"); // 60 vs 45 reps
  });
});

describe("assisted exercises: less assistance is better", () => {
  it("lower weight (the help) is better", () => {
    const c = compareExercise(sess("2031-03-08", [ws(25, 8)]), [sess("2031-03-01", [ws(30, 8)])], { type: "bodyweight_assisted" });
    expect(c).toMatchObject({ measure: "assistance", verdict: "better" });
  });
});

describe("cardio", () => {
  const CARDIO = { type: "distance_duration" as const, title: "Ski Erg" };
  const row = (m: number, s: number) => ws(null, null, { distance_m: m, duration_s: s });
  it("pace in seconds per 500 m from the time on both sessions (lower is better)", () => {
    const c = compareExercise(sess("2031-03-08", [row(200, 41), row(200, 43)]), [sess("2031-03-01", [row(400, 90)])], CARDIO);
    expect(c).toMatchObject({ measure: "pace", verdict: "better" });
    expect(c.today!.value).toBeCloseTo(105, 1); // 84 s / 400 m * 500
    expect(c.last!.value).toBeCloseTo(112.5, 1);
  });
  it("a pace within 2% is the same", () => {
    expect(compareExercise(sess("2031-03-08", [row(400, 89)]), [sess("2031-03-01", [row(400, 90)])], CARDIO).verdict).toBe("same");
  });
  it("running is minutes per mile", () => {
    const c = compareExercise(sess("2031-03-08", [row(1609.344, 540)]), [sess("2031-03-01", [row(1609.344, 600)])], { type: "distance_duration", title: "Running (Treadmill)" });
    expect(c.today).toMatchObject({ unit: "min_per_mile" });
    expect(c.today!.value).toBeCloseTo(9, 2);
    expect(c.verdict).toBe("better");
  });
  it("very different distances are not compared (a sprint is not a long piece)", () => {
    const c = compareExercise(sess("2031-03-08", [row(400, 90)]), [sess("2031-03-01", [row(1000, 250)])], CARDIO);
    expect(c.not_compared).toMatch(/distance/i);
  });
  it("distance only (no time on both) has no performance measure", () => {
    const c = compareExercise(sess("2031-03-08", [ws(null, null, { distance_m: 200 })]), [sess("2031-03-01", [ws(null, null, { distance_m: 200 })])], CARDIO);
    expect(c.measure).toBeNull();
    expect(c.not_compared).toMatch(/time or calories/i);
  });
  it("the same calories: compare the time; the same time: compare the calories", () => {
    const calSame = compareExercise(sess("2031-03-08", [ws(null, null, { duration_s: 120 })], { calories: 20 }), [sess("2031-03-01", [ws(null, null, { duration_s: 130 })], { calories: 20 })], CARDIO);
    expect(calSame).toMatchObject({ measure: "time", verdict: "better" });
    const timeSame = compareExercise(sess("2031-03-08", [ws(null, null, { duration_s: 120 })], { calories: 22 }), [sess("2031-03-01", [ws(null, null, { duration_s: 120 })], { calories: 20 })], CARDIO);
    expect(timeSame).toMatchObject({ measure: "calories", verdict: "better" });
  });
});

describe("first time, PRs, trend, estimated", () => {
  it("no history is a first time: nothing to compare", () => {
    const c = compareExercise(sess("2031-03-08", [ws(100, 5)]), [], WEIGHTED);
    expect(c).toMatchObject({ first_time: true, verdict: null, last: null, trend: null });
    expect(c.pr).toBeUndefined();
  });
  it("a new all-time best e1RM is a PR; matching it is not", () => {
    const hist = [sess("2031-02-01", [ws(100, 5)]), sess("2031-03-01", [ws(95, 5)])];
    expect(compareExercise(sess("2031-03-08", [ws(105, 5)]), hist, WEIGHTED).pr).toMatchObject({ kind: "e1rm" });
    expect(compareExercise(sess("2031-03-08", [ws(100, 5)]), hist, WEIGHTED).pr).toBeUndefined();
  });
  it("the most weight for that rep count is a PR even when the e1RM is not (a heavier set at fewer reps than the best day)", () => {
    const hist = [sess("2031-02-01", [ws(100, 5)]), sess("2031-02-15", [ws(80, 10)])]; // e1RM 116.7 and 106.7
    const c = compareExercise(sess("2031-03-08", [ws(106, 3)]), hist, WEIGHTED); // e1RM 116.6: not above 116.7; 106 for 3 reps beats 100 for 5
    expect(c.pr).toMatchObject({ kind: "weight_for_reps" });
  });
  it("most reps (bodyweight) and the longest hold are PRs", () => {
    expect(compareExercise(sess("2031-03-08", [ws(null, 30)]), [sess("2031-03-01", [ws(null, 25)])], { type: "reps_only" }).pr).toMatchObject({ kind: "reps" });
    expect(compareExercise(sess("2031-03-08", [ws(null, null, { duration_s: 70 })]), [sess("2031-03-01", [ws(null, null, { duration_s: 60 })])], { type: "duration" }).pr).toMatchObject({ kind: "hold" });
  });
  it("a trend needs 3 or more sessions in the last 90 days; it reports first, peak and last", () => {
    const hist = [sess("2031-01-10", [ws(90, 5)]), sess("2031-02-10", [ws(100, 5)])];
    expect(compareExercise(sess("2031-03-08", [ws(95, 5)]), hist, WEIGHTED).trend).toMatchObject({ sessions: 3, first: { date: "2031-01-10" }, peak: { date: "2031-02-10" }, last: { date: "2031-03-08" } });
    expect(compareExercise(sess("2031-03-08", [ws(95, 5)]), [hist[1]], WEIGHTED).trend).toBeNull(); // only 2
    const old = [sess("2030-10-10", [ws(90, 5)]), sess("2030-11-10", [ws(100, 5)])]; // outside 90 days
    expect(compareExercise(sess("2031-03-08", [ws(95, 5)]), old, WEIGHTED).trend).toBeNull();
  });
  it("trend direction uses the measure's threshold", () => {
    const up = [sess("2031-01-10", [ws(80, 5)]), sess("2031-02-10", [ws(90, 5)])];
    expect(compareExercise(sess("2031-03-08", [ws(100, 5)]), up, WEIGHTED).trend!.direction).toBe("up");
    const flat = [sess("2031-01-10", [ws(100, 5)]), sess("2031-02-10", [ws(100, 5)])];
    expect(compareExercise(sess("2031-03-08", [ws(100, 5)]), flat, WEIGHTED).trend!.direction).toBe("flat");
  });
  it("an assumed session on either side marks the comparison estimated", () => {
    const hist = [sess("2031-03-01", [ws(100, 5)])];
    expect(compareExercise(sess("2031-03-08", [ws(105, 5)], { assumed: true }), hist, WEIGHTED).estimated).toBe(true);
    expect(compareExercise(sess("2031-03-08", [ws(105, 5)]), [sess("2031-03-01", [ws(100, 5)], { assumed: true })], WEIGHTED).estimated).toBe(true);
    expect(compareExercise(sess("2031-03-08", [ws(105, 5)]), hist, WEIGHTED).estimated).toBeUndefined();
  });
});
