import { describe, it, expect } from "vitest";
import { compareExercise, type CompareSet, type ExerciseSession } from "@/core/compare/exercise";
import { describeComparison, sessionSummary } from "@/core/compare/format";
import { lbToKg } from "@/core/units";

// Synthetic only. The comparison works in kg; what Claude reads is in the user's units, with a plain summary of each session.
const ws = (kg: number | null, reps: number | null, over: Partial<CompareSet> = {}): CompareSet => ({ set_type: "normal", weight_kg: kg, reps, duration_s: null, distance_m: null, ...over });
const sess = (date: string, sets: CompareSet[], over: Partial<ExerciseSession> = {}): ExerciseSession => ({ wid: `w-${date}`, date, where: "gym", assumed: false, complex: null, calories: null, sets, ...over });

describe("sessionSummary", () => {
  it("weighted: the best set and the estimated max, in the user's units", () => {
    const s = sess("2031-03-01", [ws(lbToKg(135), 5), ws(lbToKg(135), 5)]);
    expect(sessionSummary(s, "weight_reps", "lb")).toBe("2 sets, best 135 lb x 5 (estimated max 157.5 lb)");
    expect(sessionSummary(s, "weight_reps", "kg")).toBe("2 sets, best 61.2 kg x 5 (estimated max 71.4 kg)");
  });
  it("bodyweight, hold and cardio read in plain words", () => {
    expect(sessionSummary(sess("d", [ws(null, 20), ws(null, 15)]), "reps_only", "lb")).toBe("35 reps in total (best set 20)");
    expect(sessionSummary(sess("d", [ws(null, null, { duration_s: 60 }), ws(null, null, { duration_s: 30 })]), "duration", "lb")).toBe("longest hold 60 s (90 s in total)");
    expect(sessionSummary(sess("d", [ws(null, null, { distance_m: 200, duration_s: 41 }), ws(null, null, { distance_m: 200, duration_s: 43 })], { calories: 23 }), "distance_duration", "lb"))
      .toBe("400 m in 1:24, 23 cal");
    expect(sessionSummary(sess("d", [ws(null, null, { distance_m: 200 })]), "distance_duration", "lb")).toBe("200 m (no time)");
  });
});

describe("describeComparison", () => {
  const last = sess("2031-03-01", [ws(lbToKg(135), 5)], { where: "class" });
  const today = sess("2031-03-08", [ws(lbToKg(145), 5)]);
  it("puts values in the user's units and adds a sentence made only of the numbers", () => {
    const c = compareExercise(today, [last], { type: "weight_reps" });
    const d: any = describeComparison(c, today, [last], { type: "weight_reps", title: "Bench Press (Barbell)", units: "lb" });
    expect(d).toMatchObject({ exercise: "Bench Press (Barbell)", measure: "e1rm", verdict: "better", unit: "lb" });
    expect(d.today).toMatchObject({ value: 169.2, summary: "1 set, best 145 lb x 5 (estimated max 169.2 lb)" });
    expect(d.last).toMatchObject({ date: "2031-03-01", where: "class", value: 157.5 });
    expect(d.change).toEqual({ abs: 11.7, pct: 7.4 });
    expect(d.line).toBe("Bench Press (Barbell): estimated max 169.2 lb vs 157.5 lb on 2031-03-01 (+7.4%, PR)");
  });
  it("a first time says so, and a not_compared says why (never 'worse')", () => {
    const first: any = describeComparison(compareExercise(today, [], { type: "weight_reps" }), today, [], { type: "weight_reps", title: "Bench", units: "lb" });
    expect(first).toMatchObject({ first_time: true });
    expect(first.line).toMatch(/first time/i);
    const twelve = sess("2031-03-08", [ws(30, 12), ws(30, 12)]);
    const maxOut = sess("2031-03-01", [ws(100, 3)]);
    const nc: any = describeComparison(compareExercise(twelve, [maxOut], { type: "weight_reps" }), twelve, [maxOut], { type: "weight_reps", title: "Squat", units: "lb" });
    expect(nc.not_compared).toMatch(/12 reps today vs 3 last time/);
    expect(nc.line).toMatch(/not compared/i);
    expect(nc.line).not.toMatch(/worse|better/i);
  });
  it("the trend's unit is the user's unit, matching its (converted) values", () => {
    const hist = [sess("2031-01-10", [ws(lbToKg(100), 5)]), sess("2031-02-10", [ws(lbToKg(110), 5)])];
    const d: any = describeComparison(compareExercise(today, hist, { type: "weight_reps" }), today, hist, { type: "weight_reps", title: "Bench", units: "lb" });
    expect(d.trend.unit).toBe("lb");
    expect(d.trend.first.value).toBe(116.7); // 100 lb x 5 -> estimated max 116.7 lb
    const k: any = describeComparison(compareExercise(today, hist, { type: "weight_reps" }), today, hist, { type: "weight_reps", title: "Bench", units: "kg" });
    expect(k.trend.unit).toBe("kg");
  });
  it("flags estimated comparisons and PRs in the line", () => {
    const est = sess("2031-03-08", [ws(lbToKg(145), 5)], { assumed: true });
    const d: any = describeComparison(compareExercise(est, [last], { type: "weight_reps" }), est, [last], { type: "weight_reps", title: "Bench", units: "lb" });
    expect(d.estimated).toBe(true);
    expect(d.line).toMatch(/\(estimated\)/);
    const pr: any = describeComparison(compareExercise(today, [last], { type: "weight_reps" }), today, [last], { type: "weight_reps", title: "Bench", units: "lb" });
    expect(pr.pr).toMatchObject({ kind: "e1rm" });
    expect(pr.line).toMatch(/PR/);
  });
});
