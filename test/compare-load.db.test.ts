import { describe, it, expect, afterAll } from "vitest";
import { createSql, type Sql } from "@/core/db";
import { loadExerciseSessions } from "@/core/compare/load";
import { upsertWorkout } from "@/core/hevy/sync";
import type { HevyExercise, HevySet, HevyWorkout } from "@/core/hevy/types";

// Synthetic data (March 2031), always rolled back.
try { process.loadEnvFile(".env.local"); } catch { /* none */ }
const url = process.env.DATABASE_URL;
const sql: Sql | undefined = url ? createSql(url) : undefined;
afterAll(async () => { await sql?.end({ timeout: 5 }); });

class Rollback extends Error {}
async function seeded(fn: (tx: Sql) => Promise<void>) {
  try { await sql!.begin(async (raw) => { const tx = raw as unknown as Sql; await seed(tx); await fn(tx); throw new Rollback(); }); }
  catch (e) { if (!(e instanceof Rollback)) throw e; }
}
const set = (index: number, type: string, kg: number | null, reps: number | null, dur: number | null = null, dist: number | null = null): HevySet =>
  ({ index, type, weight_kg: kg, reps, distance_meters: dist, duration_seconds: dur, rpe: null, custom_metric: null });
const ex = (index: number, tpl: string, title: string, sets: HevySet[]): HevyExercise => ({ index, title, notes: null, exercise_template_id: tpl, superset_id: null, sets });
const at = (d: number) => `2031-03-${String(d).padStart(2, "0")}T17:00:00Z`;
const wk = (id: string, d: number, exercises: HevyExercise[]): HevyWorkout => ({
  id, title: id, routine_id: null, description: null, start_time: at(d), end_time: at(d).replace("17:00", "17:45"), updated_at: at(d), created_at: at(d), exercises,
});
const SKI = "cl-tpl-ski", SQ = "cl-tpl-squat";
async function seed(tx: Sql) {
  await tx`insert into exercise_templates (id, title, type, primary_muscle, secondary_muscles, equipment, is_custom, updated_at) values
    (${SKI}, 'Zzload Ski Erg', 'distance_duration', 'cardio', ${tx.json([])}, 'machine', false, now()),
    (${SQ}, 'Zzload Squat', 'weight_reps', 'quadriceps', ${tx.json([])}, 'barbell', false, now())`;
  const tz = "America/Los_Angeles";
  await upsertWorkout(tx, wk("cl-w1", 3, [ex(0, SQ, "Zzload Squat", [set(0, "normal", 100, 5)])]), tz); // a gym session
  await upsertWorkout(tx, wk("cl-w2", 5, [ex(0, SQ, "Zzload Squat", [set(0, "normal", 60, 4)]), ex(1, SKI, "Zzload Ski Erg", [set(0, "normal", null, null, 41, 200), set(1, "normal", null, null, 43, 200)])]), tz); // a class
  await upsertWorkout(tx, wk("cl-w3", 8, [ex(0, SQ, "Zzload Squat", [set(0, "normal", 105, 5)])]), tz); // today's gym session
  await upsertWorkout(tx, wk("cl-w4", 9, [ex(0, SQ, "Zzload Squat", [set(0, "normal", 300, 5)])]), tz);
  await tx`update workouts set deleted = true where id = 'cl-w4'`;
  const [s] = await tx`insert into class_sessions (gym, class_type, title, start_at, end_at, window_source, local_date, board_text, planned, precision, hevy_workout_id)
    values ('Gym', 'strength', 'Zzload class', '2031-03-05T17:00:00Z', '2031-03-05T17:45:00Z', 'explicit', '2031-03-05', 'b', '{}'::jsonb, 'exact', 'cl-w2') returning id`;
  const [b] = await tx`insert into class_blocks (session_id, label, format) values (${s.id}, 'A', 'sets') returning id`;
  await tx`insert into class_movements (block_id, position, movement, exercise_template_id, target, done_sets, assumed) values
    (${b.id}, 0, 'squat', ${SQ}, ${tx.json({ complex: "1+1+2" })}, ${tx.json([{ reps: 4, weight_kg: 60 }])}, true),
    (${b.id}, 1, 'ski erg', ${SKI}, ${tx.json({ distance_m: 200 })}, ${tx.json([{ distance_m: 200, duration_s: 41, calories: 12 }, { distance_m: 200, duration_s: 43, calories: 11 }])}, false)`;
}

describe.skipIf(!sql)("loadExerciseSessions (always rolled back)", () => {
  it("returns every non-deleted session oldest first, with where, assumed, complex, calories and distance", async () => {
    await seeded(async (tx) => {
      const sq = await loadExerciseSessions(tx, SQ);
      expect(sq.map((s) => [s.date, s.where, s.assumed, s.complex])).toEqual([["2031-03-03", "gym", false, null], ["2031-03-05", "class", true, "1+1+2"], ["2031-03-08", "gym", false, null]]); // the deleted workout is gone
      const ski = await loadExerciseSessions(tx, SKI);
      expect(ski).toHaveLength(1);
      expect(ski[0]).toMatchObject({ where: "class", assumed: false, calories: 23, complex: null });
      expect(ski[0].sets.map((x) => [x.duration_s, x.distance_m])).toEqual([[41, 200], [43, 200]]);
      expect(ski[0].start_at).toBeInstanceOf(Date);
    });
  });

  it("`before` leaves out the session being compared and everything after it", async () => {
    await seeded(async (tx) => {
      const all = await loadExerciseSessions(tx, SQ);
      const today = all[all.length - 1];
      const prior = await loadExerciseSessions(tx, SQ, { before: today.start_at });
      expect(prior.map((s) => s.wid)).toEqual(["cl-w1", "cl-w2"]);
      expect(prior.some((s) => s.wid === today.wid)).toBe(false);
    });
  });

  it("a template with no sessions is an empty list", async () => {
    await seeded(async (tx) => { expect(await loadExerciseSessions(tx, "no-such-template")).toEqual([]); });
  });
});
