import { describe, it, expect } from "vitest";
import fixture from "./fixtures/class-boards/example-board-expected.json";
import { buildClassWorkout, classTitle, hevySet, missingFor, setsText, type ResolvedBlock, type ResolvedMovement } from "@/core/classes/build";
import { blockCount, deriveDoneSets } from "@/core/classes/derive";
import { MOVEMENT_ALIASES } from "@/core/classes/aliases";
import { findRaisedHrStretch } from "@/core/classes/window";
import { extractTemplateId, extractWorkout } from "@/core/classes/log";
import type { BlockInput, ClassInput, MovementInput } from "@/core/classes/types";
import { normalize } from "@/core/match";
import { lbToKg } from "@/core/units";

const board = fixture.blocks as unknown as BlockInput[];
const base: ClassInput = { gym: "Example Gym", class_type: "strength", board_text: fixture.board_text, blocks: board, precision: "partial", completion_pct: 100 };
const T0 = new Date("2026-07-22T14:02:00Z");
const T1 = new Date("2026-07-22T15:00:00Z");

describe("blockCount", () => {
  const A = board[0], D = board[3];
  it("uses the explicit count first", () => expect(blockCount({ ...A, sets_done: 4 })).toEqual({ count: 4, assumed: false }));
  it("falls back to the LOW end of a range and flags it assumed", () => expect(blockCount(A)).toEqual({ count: 3, assumed: true }));
  it("a fixed number of rounds needs no assumption", () => expect(blockCount(D)).toEqual({ count: 3, assumed: false }));
  it("scales from an overall % (75% of the 4-set top end = 3)", () => expect(blockCount(A, 75)).toEqual({ count: 3, assumed: true }));
  it("never scales below one set", () => expect(blockCount(A, 5).count).toBe(1));
});

describe("deriveDoneSets", () => {
  describe("per-side reps are stored as both sides combined", () => {
    const blk = { label: "A", format: "sets", sets: { min: 3, max: 3 }, movements: [] } as unknown as BlockInput;
    const row = (target: object) => ({ movement: "dumbbell single arm row", target }) as unknown as MovementInput;
    it("8/ARM for 3 sets derives 16, 16, 16", () => expect(deriveDoneSets(blk, row({ reps: 8, per_side: true })).sets.map((s) => s.reps)).toEqual([16, 16, 16]));
    it("a rep range doubles its low end", () => expect(deriveDoneSets(blk, row({ reps: { min: 8, max: 10 }, per_side: true })).sets.map((s) => s.reps)).toEqual([16, 16, 16]));
    it("reps_by_set doubles each set", () => expect(deriveDoneSets({ ...blk, sets_done: 3 }, row({ reps_by_set: [10, 8, 6], per_side: true })).sets.map((s) => s.reps)).toEqual([20, 16, 12]));
    it("a hold or distance is not doubled", () => {
      expect(deriveDoneSets(blk, row({ duration_s: 30, per_side: true })).sets.map((s) => s.duration_s)).toEqual([30, 30, 30]);
    });
    it("reps the caller states set by set are kept as given", () => expect(deriveDoneSets(blk, { ...row({ reps: 8, per_side: true }), done_sets: [{ reps: 14 }] } as MovementInput).sets).toEqual([{ reps: 14 }]));
    it("without per_side nothing changes", () => expect(deriveDoneSets(blk, row({ reps: 8 })).sets.map((s) => s.reps)).toEqual([8, 8, 8]));
  });

  const press = (board[0].movements[0]) as MovementInput; // 8-6-4-2
  it("8-6-4-2 done for 4 sets = 8, 6, 4, 2 (weights per set)", () => {
    const d = deriveDoneSets({ ...board[0], sets_done: 4 }, { ...press, weight: [75, 85, 95, 105] });
    expect(d.sets.map((s) => [s.reps, s.weight])).toEqual([[8, 75], [6, 85], [4, 95], [2, 105]]);
    expect(d.assumed).toBe(false);
  });
  it("8-6-4-2 done for only 3 sets = 8, 6, 4", () => {
    expect(deriveDoneSets({ ...board[0], sets_done: 3 }, press).sets.map((s) => s.reps)).toEqual([8, 6, 4]);
  });
  it("a rep range logs the LOW end and is assumed", () => {
    const crunch = board[1].movements[2] as MovementInput; // 10-12
    const d = deriveDoneSets({ ...board[1], sets_done: 3 }, crunch);
    expect(d.sets.map((s) => s.reps)).toEqual([10, 10, 10]);
    expect(d.assumed).toBe(true);
  });
  it("holds become duration sets, one per round", () => {
    const plank = board[3].movements[0] as MovementInput;
    expect(deriveDoneSets(board[3], plank).sets).toEqual([{ type: "normal", duration_s: 60 }, { type: "normal", duration_s: 60 }, { type: "normal", duration_s: 60 }]);
  });
  it("'did all but skipped the last round' = fewer rounds", () => {
    const hollow = board[3].movements[2] as MovementInput;
    expect(deriveDoneSets({ ...board[3], sets_done: 2 }, hollow).sets).toHaveLength(2);
  });
  it("a '75%' overall scales sets, flags precision as assumed, and says so", () => {
    const d = deriveDoneSets(board[1], board[1].movements[0] as MovementInput, 75);
    expect(d.sets).toHaveLength(3); // 75% of 4
    expect(d.assumed).toBe(true);
    expect(d.notes.join(" ")).toMatch(/3 of 4.*75%/);
  });
  it("MAX-rep movements are NOT invented: no count means no sets", () => {
    const situp = board[3].movements[3] as MovementInput;
    const d = deriveDoneSets(board[3], situp);
    expect(d.sets).toEqual([]);
    expect(d.notes[0]).toMatch(/max-rep count not given/);
  });
  it("explicit done_sets always win", () => {
    const situp = { ...(board[3].movements[3] as MovementInput), done_sets: [{ reps: 20 }, { reps: 18 }] };
    expect(deriveDoneSets(board[3], situp).sets).toEqual([{ reps: 20 }, { reps: 18 }]);
  });
});

// A plausible "what I did" for the 2026-07-22 board, resolved to made-up template ids (matching is tested against the DB elsewhere).
function resolved(): ResolvedBlock[] {
  const wt: Record<string, number | number[]> = {
    "barbell strict press": [75, 85, 95, 105], "pull up": 40, "dumbbell bicep curl": 25,
    "barbell bench press": [135, 155, 165, 175], "barbell pendlay row": 115, "cable crunch": 60,
    "dumbbell chest press": 40, "dumbbell single arm row": 55, "dumbbell overhead tricep extension": 30,
  };
  const done: Record<string, number> = { A: 4, B: 3, C: 3, D: 3 };
  return board.map((b) => ({
    block: { ...b, sets_done: done[b.label] },
    movements: b.movements.map((m0) => {
      const m = { ...m0, weight: wt[m0.movement], ...(m0.movement === "ab mat sit-up" ? { done_sets: [{ reps: 20 }, { reps: 18 }, { reps: 16 }] } : {}) } as MovementInput;
      const d = deriveDoneSets({ ...b, sets_done: done[b.label] }, m);
      return { m, templateId: `T-${m.movement}`, templateTitle: m.movement, sets: d.sets, assumed: d.assumed, notes: d.notes } as ResolvedMovement;
    }),
  }));
}

describe("buildClassWorkout: the 2026-07-22 board", () => {
  const { body, skipped } = buildClassWorkout({ input: base, blocks: resolved(), start: T0, end: T1, units: "lb", description: "A coaching note." });
  const ex = (name: string) => body.exercises.find((e) => e.exercise_template_id === `T-${name}`)!;

  it("titles it like the design says and carries the real times", () => {
    expect(body.title).toBe("Example Gym — Strength");
    expect(body.start_time).toBe("2026-07-22T14:02:00.000Z");
    expect(body.end_time).toBe("2026-07-22T15:00:00.000Z");
    expect(classTitle({ gym: "X", class_type: "mixed", title: "  My title " })).toBe("My title");
  });
  it("every board movement becomes an exercise, in board order", () => expect(body.exercises).toHaveLength(13));
  it("each lettered block is ONE Hevy superset (adjacent exercises share an id)", () => {
    expect(body.exercises.map((e) => e.superset_id)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3]);
  });
  it("8-6-4-2 over 4 sets is four sets of 8/6/4/2, with each weight in kg at full precision", () => {
    const press = ex("barbell strict press");
    expect(press.sets.map((s) => s.reps)).toEqual([8, 6, 4, 2]);
    expect(press.sets.map((s) => s.weight_kg)).toEqual([75, 85, 95, 105].map(lbToKg));
    expect(press.sets[0].weight_kg).toBe(75 * 0.45359237); // exactly, no rounding
  });
  it("8-6-4-2 over 3 sets is 8/6/4 (bench uses the first three of four listed weights)", () => {
    const bench = ex("barbell bench press");
    expect(bench.sets.map((s) => s.reps)).toEqual([8, 6, 4]);
    expect(bench.sets.map((s) => s.weight_kg)).toEqual([135, 155, 165].map(lbToKg));
  });
  it("the plank is three 60-second duration sets with no reps or weight", () => {
    const plank = ex("plank");
    expect(plank.sets).toHaveLength(3);
    expect(plank.sets[0]).toMatchObject({ duration_seconds: 60, reps: null, weight_kg: null });
  });
  it("per-side and complex notation lands in the exercise note", () => {
    expect(ex("dumbbell single arm row").notes).toMatch(/\d+ = \d+ per side/);
    expect(ex("dumbbell chest press").notes).toMatch(/1\+1\+2 complex \(1 left arm, 1 right arm, 2 both arms = 1 rep\)/);
  });
  it("a block's note says which block it belongs to", () => {
    expect(ex("barbell strict press").notes).toMatch(/^Block A \(3-4 sets\)/);
    expect(ex("plank").notes).toMatch(/^Block D \(every 3 min x 3 rounds\)/);
  });
  it("assumed values are flagged in the exercise note", () => {
    expect(ex("cable crunch").notes).toMatch(/assumed/); // 10-12 range logged at 10
  });
  it("the Hevy description is the coaching note it is given (Phase 19), never the block-by-block station list", () => {
    expect(body.description).toBe("A coaching note.");
    expect(body.description).not.toMatch(/Board:|Assumed|BARBELL STRICT PRESS X|barbell strict press: 8 @/);
    expect(skipped).toEqual([]);
  });
  it("a long note is cut at the Hevy limit of 2,000 characters", () => {
    const long = buildClassWorkout({ input: base, blocks: resolved(), start: T0, end: T1, units: "lb", description: "x".repeat(2500) });
    expect(long.body.description).toHaveLength(2000);
  });
  it("a movement with no countable sets is left out and reported, not invented", () => {
    const r = resolved();
    r[3].movements[3].sets = [];
    const b = buildClassWorkout({ input: base, blocks: r, start: T0, end: T1, units: "lb", description: "A coaching note." });
    expect(b.body.exercises).toHaveLength(12);
    expect(b.skipped).toEqual(["D) ab mat sit-up"]);
    expect(b.body.exercises.slice(-3).every((e) => e.superset_id === 3)).toBe(true);
  });
  it("a block left with one exercise is NOT a superset", () => {
    const r = resolved().slice(0, 1);
    r[0].movements[1].sets = []; r[0].movements[2].sets = [];
    const b = buildClassWorkout({ input: base, blocks: r, start: T0, end: T1, units: "lb", description: "A coaching note." });
    expect(b.body.exercises.map((e) => e.superset_id)).toEqual([null]);
  });
  it("kg users pass through untouched", () => {
    const b = buildClassWorkout({ input: base, blocks: resolved(), start: T0, end: T1, units: "kg", description: "A coaching note." });
    expect(b.body.exercises[0].sets[0].weight_kg).toBe(75);
  });
});

describe("movement aliases", () => {
  it("fix the board's typo and abbreviations", () => {
    expect(MOVEMENT_ALIASES[normalize("Barbell PENDLEY Row")]).toBe("Pendlay Row (Barbell)");
    expect(MOVEMENT_ALIASES[normalize("DB bicep curl")]).toBe("Bicep Curl (Dumbbell)"); // "db" is expanded to "dumbbell" first
    expect(MOVEMENT_ALIASES[normalize("Ab Mat Sit-Ups")]).toBe("Sit Up");
    expect(MOVEMENT_ALIASES[normalize("V-Up")]).toBe("V Up");
  });
  it("every movement on the July 22 board is covered except 'hollow hold' (no Hevy exercise: needs create_custom or a choice)", () => {
    const missing = board.flatMap((b) => b.movements.map((m) => m.movement)).filter((m) => !MOVEMENT_ALIASES[normalize(m)]);
    expect(missing).toEqual(["hollow hold"]);
  });
});

describe("findRaisedHrStretch", () => {
  const MIN = 60_000, t0 = Date.parse("2026-07-22T14:00:00Z");
  const pts = (arr: [number, number][]) => arr.map(([m, bpm]) => ({ t: t0 + m * MIN, bpm }));
  it("finds a sustained raised stretch and ignores brief spikes", () => {
    const hr = pts([[0, 70], [5, 72], [10, 120], [14, 125], [18, 130], [22, 128], [26, 124], [30, 126], [34, 80], [60, 140]]);
    const s = findRaisedHrStretch(hr, t0 + 15 * MIN, { minBpm: 104, minMinutes: 15 })!;
    expect([(s.start - t0) / MIN, (s.end - t0) / MIN]).toEqual([10, 30]);
  });
  it("returns null when nothing is sustained long enough", () => {
    expect(findRaisedHrStretch(pts([[0, 70], [10, 120], [14, 125], [40, 130]]), t0 + 10 * MIN, { minBpm: 104 })).toBeNull();
  });
  it("a gap longer than the allowed silence splits the stretch", () => {
    const hr = pts([[0, 120], [5, 120], [10, 120], [30, 120], [35, 120]]);
    expect(findRaisedHrStretch(hr, t0, { minBpm: 104, minMinutes: 25 })).toBeNull();
  });
});

describe("reading Hevy's replies", () => {
  it("a new exercise's id: the REAL bare string, a number, or the wrapped shapes", () => {
    expect(extractTemplateId("1b665ff4-8470-493c-bcdf-fdd4381e567d")).toBe("1b665ff4-8470-493c-bcdf-fdd4381e567d");
    expect(extractTemplateId("  ABC  ")).toBe("ABC");
    expect(extractTemplateId(4242)).toBe("4242");
    expect(extractTemplateId({ id: "OBJ" })).toBe("OBJ");
    expect(extractTemplateId({ id: 7 })).toBe("7");
    expect(extractTemplateId({ exercise_template: { id: "NEST" } })).toBe("NEST");
  });
  it("an unreadable reply is null (the workout is then not sent), never a guess", () => {
    for (const bad of [null, undefined, "", "   ", {}, { surprise: true }, [], { id: null }]) expect(extractTemplateId(bad)).toBeNull();
  });
  it("a new workout's id: the REAL one-item array, or a bare object", () => {
    expect(extractWorkout({ workout: [{ id: "w1", title: "x" }] })?.id).toBe("w1");
    expect(extractWorkout({ workout: { id: "w2" } })?.id).toBe("w2");
    expect(extractWorkout({ id: "w3" })?.id).toBe("w3");
    expect(extractWorkout({ workout: [] })).toBeNull();
    expect(extractWorkout("nope")).toBeNull();
  });
});

describe("Hevy set fields follow the exercise TYPE (2026-10-13: a 200 m ski sent as reps showed as 0 mi)", () => {
  it("distance exercises get distance_meters (rounded meters) and time, never reps or weight", () => {
    expect(hevySet({ reps: 150, distance_m: 200.4, duration_s: 55 }, "distance_duration", "lb")).toMatchObject({ distance_meters: 200, duration_seconds: 55, reps: null, weight_kg: null });
  });
  it("timed exercises get duration only; weight_duration keeps the weight in kg", () => {
    expect(hevySet({ duration_s: 60, reps: 3 }, "duration", "lb")).toMatchObject({ duration_seconds: 60, reps: null, distance_meters: null });
    expect(hevySet({ duration_s: 30, weight: 50 }, "weight_duration", "lb")).toMatchObject({ duration_seconds: 30, weight_kg: lbToKg(50) });
  });
  it("rep exercises get reps (and weight in kg); stray distance or time is not sent", () => {
    expect(hevySet({ reps: 16, weight: 10, distance_m: 5, duration_s: 9 }, "weight_reps", "lb")).toMatchObject({ reps: 16, weight_kg: lbToKg(10), distance_meters: null, duration_seconds: null });
    expect(hevySet({ reps: 8, weight: 0 }, "reps_only", "lb")).toMatchObject({ reps: 8, weight_kg: null });
  });
  it("an unknown type sends whatever was given", () => {
    expect(hevySet({ reps: 5, distance_m: 100 }, null, "lb")).toMatchObject({ reps: 5, distance_meters: 100 });
    expect(hevySet({ reps: 5 }, "floors_duration", "lb")).toMatchObject({ reps: 5 });
  });
  it("says what a set is missing for its type, so the dry run stops instead of logging 0", () => {
    expect(missingFor("distance_duration", { reps: 150 })).toMatch(/distance_m/);
    expect(missingFor("distance_duration", { duration_s: 60 })).toBeNull(); // time alone is fine (distance unknown)
    expect(missingFor("short_distance_weight", { reps: 2 })).toMatch(/distance_m/);
    expect(missingFor("duration", { reps: 3 })).toMatch(/duration_s/);
    expect(missingFor("weight_reps", { duration_s: 30 })).toBe("reps");
    expect(missingFor("weight_reps", { reps: 8 })).toBeNull();
    expect(missingFor(null, {})).toBeNull();
  });
  it("describes sets briefly in the user's units", () => {
    expect(setsText([{ distance_m: 200 }, { distance_m: 200 }], "lb")).toBe("2 x 200 m");
    expect(setsText([{ reps: 16, weight: 10 }, { reps: 16, weight: 10 }], "lb")).toBe("2 x 16 @ 10 lb");
    expect(setsText([{ reps: 18 }, { reps: 18 }, { reps: 10 }], "lb")).toBe("18, 18, 10");
    expect(setsText([{ duration_s: 45 }], "lb")).toBe("45 s");
    expect(setsText([], "lb")).toBe("not counted");
  });
  it("a distance target becomes a distance on every derived set", () => {
    const blk: BlockInput = { label: "A", format: "other", rounds: 3, sets_done: 2, movements: [] };
    const d = deriveDoneSets(blk, { movement: "ski", target: { distance_m: 200 } });
    expect(d.sets).toEqual([{ type: "normal", distance_m: 200 }, { type: "normal", distance_m: 200 }]);
  });
  it("a plain 'bike' is Cycling; air/assault/echo bikes are Air Bike; ski and row map to their machines", () => {
    expect(MOVEMENT_ALIASES["bike"]).toBe("Cycling");
    expect(MOVEMENT_ALIASES["assault bike"]).toBe("Air Bike");
    expect(MOVEMENT_ALIASES["ski"]).toBe("Ski Erg");
    expect(MOVEMENT_ALIASES["row"]).toBe("Rowing Machine");
  });
});
