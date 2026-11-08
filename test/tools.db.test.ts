import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { upsertWorkout } from "@/core/hevy/sync";
import type { HevyExercise, HevySet, HevyWorkout } from "@/core/hevy/types";
import { ToolError, type ToolCtx } from "@/core/tools/context";
import { searchExercises } from "@/core/tools/exercises";
import { getExerciseProgress } from "@/core/tools/progress";
import { getTrainingSummary } from "@/core/tools/summary";
import { getRecentWorkouts, getWorkoutDetails } from "@/core/tools/workouts";

// Real database, but every test runs in a transaction that is ALWAYS rolled
// back. Seeded data lives in March 2031 with "Zztest" names so it can never
// collide with real workouts. Skipped when no DATABASE_URL exists.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function seeded(fn: (ctx: (units?: "kg" | "lb") => ToolCtx, tx: Sql) => Promise<void>) {
  try {
    await sql!.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await seed(tx);
      await fn((units = "kg") => ({ sql: tx, timezone: "America/Los_Angeles", units, now: () => new Date("2031-03-20T18:00:00Z") }), tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

const set = (index: number, type: string, kg: number | null, reps: number | null, dur: number | null = null): HevySet =>
  ({ index, type, weight_kg: kg, reps, distance_meters: null, duration_seconds: dur, rpe: null, custom_metric: null });
const ex = (index: number, tpl: string, title: string, sets: HevySet[]): HevyExercise =>
  ({ index, title, notes: null, exercise_template_id: tpl, superset_id: null, sets });
const day = (d: number) => `2031-03-${String(d).padStart(2, "0")}T17:00:00Z`; // 10:00 Pacific, same local date
const wk = (id: string, d: number, exercises: HevyExercise[]): HevyWorkout => ({
  id, title: id, routine_id: null, description: null, start_time: day(d),
  end_time: day(d).replace("17:00", "17:45"), updated_at: day(d), created_at: day(d), exercises,
});

const BENCH = "test-tpl-bench", PULL = "test-tpl-pull", PLANK = "test-tpl-plank", CABLE = "test-tpl-bench-cable";
async function seed(tx: Sql) {
  await tx`insert into exercise_templates (id, title, type, primary_muscle, secondary_muscles, equipment, is_custom, updated_at) values
    (${BENCH}, 'Zztest Bench Press (Barbell)', 'weight_reps', 'chest', ${tx.json(["triceps", "shoulders"])}, 'barbell', false, now()),
    (${CABLE}, 'Zztest Bench Press (Cable)', 'weight_reps', 'chest', ${tx.json([])}, 'cable', false, now()),
    (${PULL}, 'Zztest Pull Up (Assisted)', 'bodyweight_assisted', 'lats', ${tx.json(["biceps"])}, 'machine', false, now()),
    (${PLANK}, 'Zztest Plank', 'duration', 'abdominals', ${tx.json([])}, 'none', false, now())`;
  const tz = "America/Los_Angeles";
  await upsertWorkout(tx, wk("test-w1", 3, [
    ex(0, BENCH, "Zztest Bench Press (Barbell)", [set(0, "warmup", 60, 5), set(1, "normal", 100, 5), set(2, "normal", 100, 5)]),
    ex(1, PULL, "Zztest Pull Up (Assisted)", [set(0, "normal", 40, 8)]),
  ]), tz);
  await upsertWorkout(tx, wk("test-w2", 5, [
    ex(0, BENCH, "Zztest Bench Press (Barbell)", [set(0, "normal", 105, 5), set(1, "normal", 105, 3)]),
    ex(1, PULL, "Zztest Pull Up (Assisted)", [set(0, "normal", 30, 8)]),
  ]), tz);
  await upsertWorkout(tx, wk("test-w3", 12, [
    ex(0, BENCH, "Zztest Bench Press (Barbell)", [set(0, "normal", 100, 6), set(1, "normal", 110, 1)]),
    ex(1, PULL, "Zztest Pull Up (Assisted)", [set(0, "normal", 30, 10)]),
    ex(2, PLANK, "Zztest Plank", [set(0, "normal", null, null, 60)]),
  ]), tz);
  // A deleted workout must never count, however heavy.
  await upsertWorkout(tx, wk("test-w4", 13, [ex(0, BENCH, "Zztest Bench Press (Barbell)", [set(0, "normal", 200, 5)])]), tz);
  await tx`update workouts set deleted = true where id = 'test-w4'`;
}

describe.skipIf(!sql)("read tools against Postgres (always rolled back)", () => {
  it("exercise progress: top sets, e1RM, volume, all-time PRs, deleted excluded", async () => {
    await seeded(async (ctx) => {
      const r = await getExerciseProgress(ctx(), { exercise: BENCH, since: "2031-03-01" });
      expect(r.sessions_all_time).toBe(3); // the deleted 200 kg workout is ignored
      expect(r.sessions.map((s) => s.date)).toEqual(["2031-03-03", "2031-03-05", "2031-03-12"]);

      const [s1, s2, s3] = r.sessions;
      expect(s1).toMatchObject({ working_sets: 2, top_set: { weight: 100, reps: 5 }, best_e1rm: 116.7, volume: 1000 }); // warm-up 60×5 ignored
      expect(s2).toMatchObject({ top_set: { weight: 105, reps: 5 }, best_e1rm: 122.5, volume: 840, pr: true }); // ties on weight go to more reps
      expect(s3).toMatchObject({ top_set: { weight: 110, reps: 1 }, best_e1rm: 120, volume: 710 });
      // Regression: the best e1RM (120) came from 100 x 6, NOT from the heaviest set (110 x 1).
      expect(s3.best_e1rm_from).toMatchObject({ weight: 100, reps: 6 });
      expect(s2.best_e1rm_from).toMatchObject({ weight: 105, reps: 5 });
      expect(s1.pr).toBeUndefined();
      expect(s3.pr).toBeUndefined(); // 120 < 122.5

      // Regression: "heaviest" means actual weight (110), not the best e1RM session (105).
      expect(r.all_time.top_set).toMatchObject({ date: "2031-03-12", weight: 110, reps: 1 });
      expect(r.all_time.best_e1rm).toMatchObject({ date: "2031-03-05", value: 122.5, from: { weight: 105, reps: 5 } });

      expect(r.trend).toMatchObject({
        change_per_30_days: 5.4, // least-squares, hand-computed: 5.41
        peak_session: { date: "2031-03-05", e1rm: 122.5 },
        last_session: { date: "2031-03-12", e1rm: 120 },
        last_vs_peak_pct: -2, // (120 - 122.5) / 122.5 = -2.04%
      });
    });
  });

  it("PR flags look at ALL history even when the window is shorter", async () => {
    await seeded(async (ctx) => {
      const r = await getExerciseProgress(ctx(), { exercise: BENCH, since: "2031-03-05" });
      expect(r.sessions_in_window).toBe(2);
      expect(r.sessions_all_time).toBe(3);
      expect(r.sessions[0]).toMatchObject({ date: "2031-03-05", pr: true }); // beat the 03-03 session outside the window
    });
  });

  it("converts to pounds only at the output", async () => {
    await seeded(async (ctx) => {
      const r = await getExerciseProgress(ctx("lb"), { exercise: BENCH, since: "2031-03-01" });
      expect(r.units).toBe("lb");
      expect(r.sessions[0].top_set).toMatchObject({ weight: 220.5 }); // 100 kg
    });
  });

  it("assisted pull-ups: least assistance wins, no e1RM, no volume, PR on less help", async () => {
    await seeded(async (ctx) => {
      const r = await getExerciseProgress(ctx(), { exercise: PULL, since: "2031-03-01" });
      expect(r.metric_note).toMatch(/Assisted/);
      expect(r.sessions.map((s) => s.top_set)).toEqual([
        { type: "normal", weight: 40, reps: 8 },
        { type: "normal", weight: 30, reps: 8 },
        { type: "normal", weight: 30, reps: 10 },
      ]);
      expect(r.sessions.every((s) => s.best_e1rm === null && s.volume === 0)).toBe(true);
      expect(r.sessions.map((s) => s.pr === true)).toEqual([false, true, false]);
      expect(r.trend).toBeNull();
    });
  });

  it("finds an exercise by loose name, and explains when you haven't done it", async () => {
    await seeded(async (ctx) => {
      const r = await getExerciseProgress(ctx(), { exercise: "zztest bench press", since: "2031-03-01" });
      expect(r.exercise.id).toBe(BENCH); // the barbell one, which has sessions; the never-done cable one is not chosen
      await expect(getExerciseProgress(ctx(), { exercise: "zztest bench cable" })).rejects.toThrow(ToolError);
      await expect(getExerciseProgress(ctx(), { exercise: "qqqqq" })).rejects.toThrow(/haven't done/);
    });
  });

  it("recent workouts: newest first, volumes right, deleted hidden, assisted adds no volume", async () => {
    await seeded(async (ctx) => {
      const r = await getRecentWorkouts(ctx(), { start: "2031-03-01", end: "2031-03-31" });
      expect(r.workouts.map((w) => w.id)).toEqual(["test-w3", "test-w2", "test-w1"]);
      expect(r.workouts.map((w) => w.volume)).toEqual([710, 840, 1000]);
      expect(r.total_volume).toBe(2550);
      expect(r.workouts[0]).toMatchObject({ date: "2031-03-12", time: "10:00", duration_min: 45, working_sets: 4 });
      expect(r.workouts[0].exercises).toEqual(["Zztest Bench Press (Barbell)", "Zztest Pull Up (Assisted)", "Zztest Plank"]);
      await expect(getRecentWorkouts(ctx(), { start: "2031-03-10", end: "2031-03-01" })).rejects.toThrow(ToolError);
      await expect(getRecentWorkouts(ctx(), { start: "2020-01-01", end: "2031-03-01" })).rejects.toThrow(/too long/);
    });
  });

  it("workout details: latest, by id, per-exercise stats, and helpful errors", async () => {
    await seeded(async (ctx) => {
      const latest = await getWorkoutDetails(ctx(), {});
      expect(latest.workout).toMatchObject({ id: "test-w3", date: "2031-03-12" }); // the deleted 03-13 workout is skipped
      expect(latest.totals).toEqual({ exercises: 3, working_sets: 4, volume: 710 });
      const bench = latest.exercises[0];
      expect(bench).toMatchObject({ title: "Zztest Bench Press (Barbell)", top_set: { weight: 110, reps: 1 }, best_e1rm: 120, best_e1rm_from: { weight: 100, reps: 6 }, volume: 710 });
      expect(latest.exercises[1]).toMatchObject({ best_e1rm: null, volume: 0, note: expect.stringMatching(/assisted/) });
      expect(latest.exercises[2].top_set).toMatchObject({ duration_s: 60 });

      const byId = await getWorkoutDetails(ctx(), { workout_id: "test-w1" });
      expect(byId.exercises[0].sets).toHaveLength(3); // warm-up shown in the listing, not counted
      expect(byId.exercises[0].working_sets).toBe(2);

      await expect(getWorkoutDetails(ctx(), { workout_id: "nope" })).rejects.toThrow(/No workout with id/);
      await expect(getWorkoutDetails(ctx(), { workout_id: "test-w4" })).rejects.toThrow(ToolError); // deleted
    });
  });

  it("training summary: weeks start Monday, muscle credit 1 / 0.5, empty weeks shown", async () => {
    await seeded(async (ctx) => {
      const r = await getTrainingSummary(ctx(), { start: "2031-03-03", end: "2031-03-23" });
      expect(r.weeks.map((w) => [w.week_start, w.sessions, w.hard_sets])).toEqual([
        ["2031-03-03", 2, 6],
        ["2031-03-10", 1, 4],
        ["2031-03-17", 0, 0], // a gap week is shown, not skipped
      ]);
      expect(r.weeks[0].hard_sets_by_muscle).toEqual({ chest: 4, triceps: 2, shoulders: 2, lats: 2, biceps: 1 });
      expect(r.weeks[1].hard_sets_by_muscle).toEqual({ chest: 2, lats: 1, abdominals: 1, triceps: 1, shoulders: 1, biceps: 0.5 });
      expect(r.totals).toMatchObject({ sessions: 3, hard_sets: 10, volume: 2550 }); // assisted pull-ups add no volume
      expect(r.totals.hard_sets_by_muscle).toMatchObject({ chest: 6, triceps: 3, shoulders: 3, lats: 3, biceps: 1.5, abdominals: 1 });
      expect(r.sessions_by_kind).toEqual({ lifting: 3 });
      expect(r.most_trained[0]).toEqual({ muscle: "chest", sets: 6 });
      expect(r.least_trained.some((m) => m.sets === 0)).toBe(true); // untouched muscles surface as neglected
      expect(r.main_lifts).toHaveLength(5);
      await expect(getTrainingSummary(ctx(), { start: "2031-03-10", end: "2031-03-01" })).rejects.toThrow(ToolError);
    });
  });

  it("training summary assigns a Sunday to the PREVIOUS Monday's week", async () => {
    await seeded(async (ctx, tx) => {
      await upsertWorkout(tx, wk("test-sun", 9, [ex(0, BENCH, "Zztest Bench Press (Barbell)", [set(0, "normal", 80, 5)])]), "America/Los_Angeles"); // Sun Mar 9
      const r = await getTrainingSummary(ctx(), { start: "2031-03-03", end: "2031-03-16" });
      expect(r.weeks[0]).toMatchObject({ week_start: "2031-03-03", sessions: 3 }); // w1, w2, and the Sunday session
      expect(r.weeks[1]).toMatchObject({ week_start: "2031-03-10", sessions: 1 });
    });
  });

  it("search: done exercises first, with last top set; never-done ones after", async () => {
    await seeded(async (ctx) => {
      const r = await searchExercises(ctx(), { query: "zztest bench" });
      expect(r.results.map((x) => x.id)).toEqual([BENCH, CABLE]);
      expect(r.results[0]).toMatchObject({ times_done: 3, last_done: "2031-03-12", last_top_set: { weight: 110, reps: 1 } });
      expect(r.results[1].times_done).toBe(0);
      expect((await searchExercises(ctx(), { query: "zztest bench", limit: 1 })).results).toHaveLength(1);
      expect((await searchExercises(ctx(), { query: "qqqq" })).results).toEqual([]);
    });
  });
});
