import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { upsertWorkout } from "@/core/hevy/sync";
import type { HevyExercise, HevySet, HevyWorkout } from "@/core/hevy/types";
import type { ToolCtx } from "@/core/tools/context";
import { getExerciseProgress } from "@/core/tools/progress";

// CHARACTERIZATION SNAPSHOT (Phase 19 B). get_exercise_progress is refactored to use a shared session loader; its output
// must not change by a single character. This test pins today's output for synthetic data (a weighted lift with a class
// session and a deleted workout, an assisted lift, a hold, a reps-only exercise), in lb and in kg.
// If it fails after a change you did NOT mean to make, the change is a bug. Do not regenerate the golden file to make it pass.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function seeded(fn: (tx: Sql) => Promise<void>) {
  try { await sql!.begin(async (raw) => { const tx = raw as unknown as Sql; await seed(tx); await fn(tx); throw new Rollback(); }); }
  catch (e) { if (!(e instanceof Rollback)) throw e; }
}

const set = (index: number, type: string, kg: number | null, reps: number | null, dur: number | null = null): HevySet =>
  ({ index, type, weight_kg: kg, reps, distance_meters: null, duration_seconds: dur, rpe: null, custom_metric: null });
const ex = (index: number, tpl: string, title: string, sets: HevySet[]): HevyExercise => ({ index, title, notes: null, exercise_template_id: tpl, superset_id: null, sets });
const at = (d: number) => `2031-03-${String(d).padStart(2, "0")}T17:00:00Z`;
const wk = (id: string, d: number, exercises: HevyExercise[]): HevyWorkout => ({
  id, title: id, routine_id: null, description: null, start_time: at(d), end_time: at(d).replace("17:00", "17:45"), updated_at: at(d), created_at: at(d), exercises,
});

const BENCH = "gold-tpl-bench", PULL = "gold-tpl-pull", PLANK = "gold-tpl-plank", PUSH = "gold-tpl-push";
async function seed(tx: Sql) {
  await tx`insert into exercise_templates (id, title, type, primary_muscle, secondary_muscles, equipment, is_custom, updated_at) values
    (${BENCH}, 'Zzgold Bench Press (Barbell)', 'weight_reps', 'chest', ${tx.json(["triceps"])}, 'barbell', false, now()),
    (${PULL}, 'Zzgold Pull Up (Assisted)', 'bodyweight_assisted', 'lats', ${tx.json(["biceps"])}, 'machine', false, now()),
    (${PLANK}, 'Zzgold Plank', 'duration', 'abdominals', ${tx.json([])}, 'none', false, now()),
    (${PUSH}, 'Zzgold Push Up', 'reps_only', 'chest', ${tx.json([])}, 'none', false, now())`;
  const tz = "America/Los_Angeles";
  await upsertWorkout(tx, wk("gold-w1", 3, [
    ex(0, BENCH, "Zzgold Bench Press (Barbell)", [set(0, "warmup", 60, 5), set(1, "normal", 100, 5), set(2, "normal", 100, 5)]),
    ex(1, PULL, "Zzgold Pull Up (Assisted)", [set(0, "normal", 40, 8)]),
    ex(2, PUSH, "Zzgold Push Up", [set(0, "normal", null, 20), set(1, "normal", null, 18)]),
  ]), tz);
  await upsertWorkout(tx, wk("gold-w2", 5, [ // a logged CLASS
    ex(0, BENCH, "Zzgold Bench Press (Barbell)", [set(0, "normal", 105, 5), set(1, "normal", 105, 3)]),
    ex(1, PULL, "Zzgold Pull Up (Assisted)", [set(0, "normal", 30, 8)]),
    ex(2, PLANK, "Zzgold Plank", [set(0, "normal", null, null, 45)]),
  ]), tz);
  await upsertWorkout(tx, wk("gold-w3", 12, [
    ex(0, BENCH, "Zzgold Bench Press (Barbell)", [set(0, "normal", 100, 6), set(1, "normal", 110, 1), set(2, "failure", 90, 9)]),
    ex(1, PULL, "Zzgold Pull Up (Assisted)", [set(0, "normal", 30, 10)]),
    ex(2, PLANK, "Zzgold Plank", [set(0, "normal", null, null, 60)]),
    ex(3, PUSH, "Zzgold Push Up", [set(0, "normal", null, 25)]),
  ]), tz);
  await upsertWorkout(tx, wk("gold-w4", 13, [ex(0, BENCH, "Zzgold Bench Press (Barbell)", [set(0, "normal", 200, 5)])]), tz);
  await tx`update workouts set deleted = true where id = 'gold-w4'`; // a deleted workout never counts
  await tx`insert into class_sessions (gym, class_type, title, start_at, end_at, window_source, local_date, board_text, planned, precision, hevy_workout_id)
    values ('Gym', 'strength', 'Gold class', '2031-03-05T17:00:00Z', '2031-03-05T17:45:00Z', 'explicit', '2031-03-05', 'b', '{}'::jsonb, 'exact', 'gold-w2')`;
}

const ctxOf = (tx: Sql, units: "lb" | "kg"): ToolCtx => ({ sql: tx, timezone: "America/Los_Angeles", units, now: () => new Date("2031-03-20T18:00:00Z") });
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

describe.skipIf(!sql)("get_exercise_progress characterization snapshot (always rolled back)", () => {
  it("output is byte-for-byte the golden file for every exercise type, in lb and kg", async () => {
    await seeded(async (tx) => {
      const out: Record<string, unknown> = {};
      for (const units of ["lb", "kg"] as const) {
        for (const name of ["Zzgold Bench Press (Barbell)", "Zzgold Pull Up (Assisted)", "Zzgold Plank", "Zzgold Push Up"]) {
          out[`${units} | ${name}`] = await getExerciseProgress(ctxOf(tx, units), { exercise: name });
        }
      }
      out["lb | bench since 2031-03-10"] = await getExerciseProgress(ctxOf(tx, "lb"), { exercise: "Zzgold Bench Press (Barbell)", since: "2031-03-10" });
      await expect(json(out)).toMatchFileSnapshot("./fixtures/exercise-progress.golden.json");
    });
  });
});
