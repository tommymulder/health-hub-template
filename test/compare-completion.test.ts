import { describe, it, expect } from "vitest";
import { classCompletion, completionTrends, normalizeClassName, THRESHOLD_POINTS, MIN_CLASSES, type CBlock, type CClass, type CMovement } from "@/core/compare/completion";

// Synthetic classes only. done_sets use the stored shape (weight_kg, reps, duration_s, distance_m, calories).
const mv = (movement: string, target: CMovement["target"], done: CMovement["done_sets"], over: Partial<CMovement> = {}): CMovement => ({ movement, target, done_sets: done, variant_done: null, assumed: false, ...over });
const sets = (label: string, max: number, movements: CMovement[], over: Partial<CBlock> = {}): CBlock => ({ label, format: "sets", sets_min: 3, sets_max: max, rounds: null, finish_s: null, movements, ...over });
const cls = (blocks: CBlock[], over: Partial<CClass> = {}): CClass => ({ id: 1, title: "BUILD - Upper Body", class_type: "strength", date: "2031-03-08", blocks, ...over });
const reps = (n: number, k = 1) => Array.from({ length: k }, () => ({ reps: n }));

describe("per movement: posted work = per-round target x posted rounds x share", () => {
  it("sets block: the posted rounds are sets.max", () => {
    const c = classCompletion(cls([sets("A", 4, [mv("bench", { reps: 8 }, reps(8, 3))])]));
    expect(c.blocks[0].movements[0]).toMatchObject({ countable: true, posted: 32, done: 24, unit: "reps", pct: 75 });
    expect(c.pct).toBe(75);
  });
  it("another format uses the block's posted rounds", () => {
    const b = sets("B", 0, [mv("row", { distance_m: 250 }, [{ distance_m: 250 }, { distance_m: 250 }])], { format: "every_n_minutes", sets_min: null, sets_max: null, rounds: 3 });
    expect(classCompletion(cls([b])).blocks[0].movements[0]).toMatchObject({ posted: 750, done: 500, unit: "m" });
  });
  it("`total` ignores the rounds: a cash-out of 40 power cleans, split 50/50, done 20 = 100%", () => {
    const c = classCompletion(cls([sets("D", 1, [mv("power clean", { reps: 40, total: true, share: 0.5 }, reps(20))])]));
    expect(c.blocks[0].movements[0]).toMatchObject({ posted: 20, done: 20, pct: 100 });
  });
  it("a partner share scales the per-round work", () => {
    const b = sets("C", 0, [mv("wall ball", { reps: 10, share: 0.5 }, reps(5, 3))], { format: "for_time", rounds: 3, sets_min: null, sets_max: null });
    expect(classCompletion(cls([b])).blocks[0].movements[0]).toMatchObject({ posted: 15, done: 15, pct: 100 });
  });
  it("a range counts at its top, the board's full ask", () => {
    expect(classCompletion(cls([sets("A", 3, [mv("curl", { reps: { min: 10, max: 12 } }, reps(10, 3))])])).blocks[0].movements[0]).toMatchObject({ posted: 36, done: 30 });
  });
  it("reps_by_set: 8-6-4-2 with 4 posted sets is 20; with 3 posted sets it is 18", () => {
    const m = () => mv("press", { reps_by_set: [8, 6, 4, 2] }, [{ reps: 8 }, { reps: 6 }, { reps: 4 }]);
    expect(classCompletion(cls([sets("A", 4, [m()])])).blocks[0].movements[0]).toMatchObject({ posted: 20, done: 18 });
    expect(classCompletion(cls([sets("A", 3, [m()])])).blocks[0].movements[0]).toMatchObject({ posted: 18, done: 18, pct: 100 });
  });
  it("per_side counts both sides (done reps are stored as both sides combined)", () => {
    expect(classCompletion(cls([sets("A", 3, [mv("db row", { reps: 8, per_side: true }, reps(16, 3))])])).blocks[0].movements[0]).toMatchObject({ posted: 48, done: 48, pct: 100 });
  });
  it("timed pieces count seconds", () => {
    const m = mv("plank", { duration_s: 60 }, [{ duration_s: 60 }, { duration_s: 45 }, { duration_s: 30 }]);
    expect(classCompletion(cls([sets("A", 3, [m])])).blocks[0].movements[0]).toMatchObject({ posted: 180, done: 135, unit: "s", pct: 75 });
  });
  it("is capped at 100%", () => {
    expect(classCompletion(cls([sets("A", 4, [mv("bench", { reps: 8 }, reps(8, 6))])])).blocks[0].movements[0]).toMatchObject({ pct: 100 });
  });
  it("weight never counts toward completion", () => {
    const light = classCompletion(cls([sets("A", 3, [mv("squat", { reps: 5 }, [{ reps: 5, weight_kg: 20 }, { reps: 5, weight_kg: 20 }, { reps: 5, weight_kg: 20 }])])]));
    expect(light.pct).toBe(100);
  });
});

describe("not countable is never 0: it is left out and listed with the reason", () => {
  it("no posted rounds", () => {
    const b = sets("B", 0, [mv("row", { distance_m: 250 }, [{ distance_m: 250 }])], { format: "every_n_minutes", sets_min: null, sets_max: null, rounds: null });
    const c = classCompletion(cls([b]));
    expect(c.pct).toBeNull();
    expect(c.not_counted[0]).toMatchObject({ block: "B", movement: "row", reason: expect.stringMatching(/no posted rounds/i) });
  });
  it("a max-reps target has no ceiling: reported as reps done, not as a percentage", () => {
    const c = classCompletion(cls([sets("A", 1, [mv("burpee", { max: true }, reps(32))])]));
    expect(c.blocks[0].movements[0]).toMatchObject({ countable: false, reps_done: 32 });
    expect(c.pct).toBeNull();
    expect(c.not_counted[0].reason).toMatch(/max/i);
  });
  it("an AMRAP block reports the rounds done instead", () => {
    const b = sets("C", 0, [mv("thruster", { reps: 10 }, reps(10, 5))], { format: "amrap", sets_min: null, sets_max: null, rounds: null });
    const r = classCompletion(cls([b])).blocks[0];
    expect(r.movements[0].countable).toBe(false);
    expect(r.amrap_reps_done).toBe(50);
  });
  it("an optional movement that was not done is left out; one that was done counts", () => {
    const opt = mv("pick: ski", { distance_m: 200, optional: true }, []);
    const base = mv("bench", { reps: 8 }, reps(8, 4));
    const c = classCompletion(cls([sets("A", 4, [base, opt])]));
    expect(c.pct).toBe(100);
    expect(c.not_counted).toEqual([expect.objectContaining({ movement: "pick: ski", reason: expect.stringMatching(/optional/i) })]);
    const done = classCompletion(cls([sets("A", 4, [base, mv("pick: ski", { distance_m: 200, optional: true }, [{ distance_m: 200 }, { distance_m: 100 }])])]));
    expect(done.blocks[0].movements[1]).toMatchObject({ countable: true, pct: 37.5 }); // 300 of 800
  });
  it("calories posted but meters logged: different units, never converted", () => {
    const c = classCompletion(cls([sets("A", 3, [mv("bike", { calories: 15 }, [{ distance_m: 400 }])])]));
    expect(c.blocks[0].movements[0]).toMatchObject({ countable: false });
    expect(c.not_counted[0].reason).toMatch(/calories.*meters|meters.*calories/i);
    const ok = classCompletion(cls([sets("A", 3, [mv("bike", { calories: 15 }, [{ calories: 15 }, { calories: 15 }, { calories: 10 }])])]));
    expect(ok.blocks[0].movements[0]).toMatchObject({ countable: true, unit: "cal", posted: 45, done: 40 });
  });
  it("a skipped (not optional) movement is real work not done: 0%, not left out", () => {
    const c = classCompletion(cls([sets("A", 3, [mv("bench", { reps: 8 }, reps(8, 3)), mv("curl", { reps: 10 }, [])])]));
    expect(c.blocks[0].movements[1]).toMatchObject({ countable: true, pct: 0 });
    expect(c.pct).toBe(50);
  });
});

describe("rolling up", () => {
  it("block % = average of its countable movements; class % = average of its countable blocks; counted and blocks_finished", () => {
    const c = classCompletion(cls([
      sets("A", 4, [mv("bench", { reps: 8 }, reps(8, 4)), mv("row", { reps: 8 }, reps(8, 2))]), // 100, 50 -> 75
      sets("B", 3, [mv("plank", { duration_s: 60 }, [{ duration_s: 60 }, { duration_s: 60 }, { duration_s: 60 }])]), // 100
      sets("C", 1, [mv("burpee", { max: true }, reps(30))]), // not countable
    ]));
    expect(c.blocks.map((b) => b.pct)).toEqual([75, 100, null]);
    expect(c.pct).toBe(87.5);
    expect(c.counted).toBe("3 of 4 movements");
    expect(c.blocks_finished).toEqual({ finished: 1, of: 2 });
  });
  it("RX on N of M movements that posted an RX weight", () => {
    const alt = [{ label: "RX", text: "50 lb" }];
    const c = classCompletion(cls([sets("A", 3, [
      mv("a", { reps: 5, alternatives: alt }, reps(5, 3), { variant_done: "RX" }),
      mv("b", { reps: 5, alternatives: alt }, reps(5, 3), { variant_done: "scaled" }),
      mv("c", { reps: 5, alternatives: alt }, reps(5, 3), { variant_done: null }),
      mv("d", { reps: 5 }, reps(5, 3)), // posted no RX
    ])]));
    expect(c.scaling).toEqual({ rx_done: 1, rx_posted: 3 });
  });
  it("only an alternative LABELLED RX counts as an RX posting (a 'sub' or 'scaled' option does not)", () => {
    const c = classCompletion(cls([sets("A", 3, [
      mv("a", { reps: 5, alternatives: [{ label: "RX" }] }, reps(5, 3), { variant_done: "rx" }), // case does not matter
      mv("b", { reps: 5, alternatives: [{ label: "sub" }] }, reps(5, 3), { variant_done: "sub" }), // a substitute is not RX
      mv("c", { reps: 5, alternatives: [{ label: "scaled" }, { label: "RX" }] }, reps(5, 3), { variant_done: "scaled" }),
      mv("d", { reps: 5, alternatives: [{ label: "RX" }] }, reps(5, 3), { variant_done: "sub" }), // done as something else than RX
    ])]));
    expect(c.scaling).toEqual({ rx_done: 1, rx_posted: 3 });
  });
  it("a movement whose sets were assumed marks the class estimated", () => {
    const c = classCompletion(cls([sets("A", 3, [mv("a", { reps: 5 }, reps(5, 3), { assumed: true })])]));
    expect(c.estimated).toBe(true);
    expect(c.blocks[0].movements[0]).toMatchObject({ estimated: true });
    expect(classCompletion(cls([sets("A", 3, [mv("a", { reps: 5 }, reps(5, 3))])])).estimated).toBe(false);
  });
  it("a for_time block carries the time he finished it in", () => {
    const b = sets("C", 0, [mv("wall ball", { reps: 10 }, reps(10, 3))], { format: "for_time", rounds: 3, sets_min: null, sets_max: null, finish_s: 540 });
    const r = classCompletion(cls([b])).blocks[0];
    expect(r).toMatchObject({ finish_s: 540, pct: 100 });
  });
});

describe("trends", () => {
  it("normalizes the class name so 'BUILD - Upper Body' matches itself", () => {
    expect(normalizeClassName("BUILD - Upper Body")).toBe(normalizeClassName("build  upper body "));
    expect(normalizeClassName("BUILD - Upper Body")).not.toBe(normalizeClassName("BUILD - Lower Body"));
  });
  const point = (n: number, pct: number | null, over: Partial<{ title: string; type: string }> = {}) => ({ id: n, title: over.title ?? "BUILD - Upper Body", class_type: over.type ?? "strength", date: `2031-02-${String(n).padStart(2, "0")}`, pct });
  it("versus the last class of the same name", () => {
    const t = completionTrends([point(1, 60), point(2, 70, { title: "Cardio Day", type: "cardio_endurance" }), point(3, 80)]);
    expect(t.by_name.find((x) => x.name === normalizeClassName("BUILD - Upper Body"))).toMatchObject({ last: 80, previous: 60, change_points: 20 });
  });
  it("a verdict needs at least 8 countable classes and a 5-point change; otherwise only the numbers", () => {
    expect(THRESHOLD_POINTS).toBe(5);
    expect(MIN_CLASSES).toBe(8);
    const few = completionTrends(Array.from({ length: 6 }, (_, i) => point(i + 1, 50 + i * 10)));
    expect(few.by_type[0]).toMatchObject({ class_type: "strength", countable_classes: 6 });
    expect(few.by_type[0].verdict).toBeNull();
    // 8 classes: last 4 average 80, the 4 before average 60 -> +20 points, better
    const eight = completionTrends([55, 60, 60, 65, 75, 80, 80, 85].map((p, i) => point(i + 1, p)));
    expect(eight.by_type[0]).toMatchObject({ last4_avg: 80, previous4_avg: 60, change_points: 20, verdict: "better" });
    const flat = completionTrends([70, 72, 71, 70, 71, 72, 70, 71].map((p, i) => point(i + 1, p)));
    expect(flat.by_type[0].verdict).toBe("same");
    const worse = completionTrends([90, 90, 85, 85, 70, 70, 65, 65].map((p, i) => point(i + 1, p)));
    expect(worse.by_type[0].verdict).toBe("worse");
  });
  it("a class-name verdict needs 8 countable classes OF THAT TYPE, not just 8 overall", () => {
    const strength = Array.from({ length: 3 }, (_, i) => point(i + 1, 50 + i * 30)); // 3 strength classes: 50, 80, 110(capped by data, fine)
    const hiit = Array.from({ length: 8 }, (_, i) => point(i + 10, 60, { title: "Cardio Day", type: "cardio_endurance" }));
    const t = completionTrends([...strength, ...hiit]);
    expect(t.by_name.find((x) => x.name === normalizeClassName("BUILD - Upper Body"))!.verdict).toBeNull(); // only 3 strength classes
    const eight = completionTrends([55, 60, 60, 65, 75, 80, 80, 85].map((p, i) => point(i + 1, p)));
    expect(eight.by_name[0]).toMatchObject({ change_points: 5, verdict: "better" }); // 8 of the type, last two 80 -> 85
  });
  it("classes that are not countable are left out of the numbers", () => {
    const t = completionTrends([point(1, 60), point(2, null), point(3, 80)]);
    expect(t.by_type[0].countable_classes).toBe(2);
  });
});

describe("for_time finish times against last time", () => {
  const ft = (finish: number | null, label = "C") => sets(label, 0, [mv("wall ball", { reps: 10 }, reps(10, 3))], { format: "for_time", rounds: 3, sets_min: null, sets_max: null, finish_s: finish });
  it("compares each for_time block's finish time with the same block of the last same-name class (lower is better)", async () => {
    const { finishTimeComparisons } = await import("@/core/compare/completion");
    const r = finishTimeComparisons(cls([ft(480)]), cls([ft(540)], { id: 0, date: "2031-03-01" }));
    expect(r).toEqual([{ block: "C", finish_s: 480, last_finish_s: 540, change_s: -60, change_pct: -11.1, verdict: "better" }]);
    expect(finishTimeComparisons(cls([ft(530)]), cls([ft(540)], { id: 0 }))[0].verdict).toBe("same"); // under 5%
    expect(finishTimeComparisons(cls([ft(600)]), cls([ft(540)], { id: 0 }))[0].verdict).toBe("worse");
    expect(finishTimeComparisons(cls([ft(null)]), cls([ft(540)], { id: 0 }))).toEqual([]); // not finished: nothing to compare
    expect(finishTimeComparisons(cls([ft(480)]), null)).toEqual([]);
  });
});

describe("a class excluded from completion", () => {
  const c = cls([sets("A", 3, [mv("squat", { reps: 8 }, reps(8, 3))])], { excluded: "board reconstructed from memory" });
  it("has no percentage and says why; it is never scored 0", () => {
    expect(classCompletion(c)).toMatchObject({ pct: null, excluded: "board reconstructed from memory", counted: "excluded (board reconstructed from memory)", counted_movements: 0, blocks_finished: { finished: 0, of: 0 } });
  });
  it("and a trend skips it", () => {
    const t = completionTrends([{ id: 1, title: "A", class_type: "strength", date: "2031-03-01", pct: classCompletion(c).pct }]);
    expect(t.by_type).toEqual([]);
  });
});
